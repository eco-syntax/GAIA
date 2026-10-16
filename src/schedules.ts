import type { Schedule } from "./config.js";
import { scheduleChatRef } from "./config.js";
import { runOneShot } from "./session.js";
import type { Config } from "./config.js";
import { addSchedule, listSchedules, parseAt, parseEvery, removeSchedule } from "./scheduleStore.js";
import { Type } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ChatRef } from "./platform.js";

/**
 * Agent-facing scheduling tool, in the same style as memory.ts: a tool the LLM
 * can call to set/list/remove recurring tasks at runtime. The result of each
 * task is delivered to the chat it was created in (the ref closure).
 */
export function scheduleTool(ref: ChatRef): ToolDefinition {
	return defineTool({
		name: "schedule",
		label: "Scheduled tasks",
		description:
			"Set or manage recurring background tasks. Each task runs on a timer and its output is delivered to this chat as a message. Use for cron-style reminders and periodic jobs (e.g. 'every morning at 08:00 summarize my open PRs'). Actions: 'add' creates a task (either an interval like '30m'/'2h'/'1d', or a daily time 'HH:MM'), 'remove' deletes one by name, 'list' shows all.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("add"), Type.Literal("remove"), Type.Literal("list")]),
			name: Type.Optional(Type.String({ description: "Unique name for the task (add/remove)" })),
			prompt: Type.Optional(Type.String({ description: "What the task should do, as a plain-text instruction (add)" })),
			every: Type.Optional(Type.String({ description: "Interval: '30m', '2h', '1d' (add; mutually exclusive with at)" })),
			at: Type.Optional(Type.String({ description: "Daily time 'HH:MM' (add; mutually exclusive with every)" })),
		}),
		async execute(_id, params) {
			if (params.action === "list") {
				// Filter to THIS chat: schedules are per-chat, so a chat must never
				// enumerate (or read the prompts of) another chat's tasks.
				const scheds = listSchedules(ref.chatId);
				if (!scheds.length) {
					return { content: [{ type: "text" as const, text: "No scheduled tasks for this chat." }], details: undefined };
				}
				const text = scheds
					.map((s) => `\u2022 ${s.name} \u2014 ${s.every ? `every ${s.every}` : `daily at ${s.at}`} (${s.platform ?? "telegram"} ${s.chatId}): ${s.prompt}`)
					.join("\n");
				return { content: [{ type: "text" as const, text }], details: undefined };
			}
			if (params.action === "remove") {
				const name = (params.name ?? "").trim();
				if (!name) {
					return { content: [{ type: "text" as const, text: "Specify the task name to remove." }], details: undefined };
				}
				// Scope deletion to THIS chat: a chat can only remove its own tasks.
				const text = removeSchedule(name, ref.chatId)
					? `Removed schedule "${name}".`
					: `No schedule named "${name}" in this chat.`;
				return { content: [{ type: "text" as const, text }], details: undefined };
			}
			// add
			const name = (params.name ?? "").trim();
			const prompt = (params.prompt ?? "").trim();
			if (!name || !prompt) {
				return { content: [{ type: "text" as const, text: "Provide both a name and a prompt for the task." }], details: undefined };
			}
			if (!params.every && !params.at) {
				return { content: [{ type: "text" as const, text: "Specify an interval (every) or a daily time (at)." }], details: undefined };
			}
			const res = addSchedule({ name, prompt, every: params.every, at: params.at, platform: ref.platform, chatId: ref.chatId });
			return {
				content: [{
					type: "text" as const,
					text: res.ok ? `Scheduled "${name}".` : `Could not schedule: ${res.error}`,
				}],
				details: undefined,
			};
		},
	});
}

/**
 * Scheduled tasks: each entry is just {name, every|at, chatId, prompt}. The
 * gateway runs a headless pi turn on a timer and delivers the text to the chat.
 * No job types, no DSL — the prompt IS the task.
 *
 * The scheduler re-reads the in-memory registry (scheduleStore) every tick, so
 * schedules the agent adds or removes at runtime take effect without a restart.
 * Edits to schedules.json on disk are NOT picked up — the file is loaded once
 * at boot.
 */

/** Whether the daily `at: "HH:MM"` time fell in (prev, now] — catches ticks skipped by event-loop stalls or suspend/resume. */
export function crossedDailyTime(prev: Date, now: Date, at: string): boolean {
	const t = parseAt(at);
	if (!t) return false;
	const atToday = new Date(now);
	atToday.setHours(t.h, t.min, 0, 0);
	return atToday > prev && atToday <= now;
}

/** Hard cap on what gets injected into a chat session: the delivered chat message
 * can be long, but the in-context copy must stay small at a 32K window. */
const INJECT_CHAR_LIMIT = 6000;

/** Append a schedule's result into the chat's session so follow-ups are grounded.
 * Hermes-style cronjobs post in isolation and the agent "forgets" them the moment
 * the task ends; this gives the next chat turn the task's output as context. */
async function injectResult(
	sched: Schedule,
	text: string,
	inject: ((ref: ChatRef, content: string) => Promise<void>) | undefined,
): Promise<void> {
	if (sched.inject === false || !inject) return;
	const ref = scheduleChatRef(sched);
	const ranAt = new Date();
	const body =
		text.length > INJECT_CHAR_LIMIT
			? `${text.slice(0, INJECT_CHAR_LIMIT)}\n…(truncated)`
			: text;
	try {
		await inject(ref, `Scheduled task "${sched.name}" result (${ranAt.toISOString()}):\n${body}`);
	} catch (err) {
		console.error(`injecting schedule "${sched.name}" result into session failed:`, err);
	}
}

export function startScheduler(
	config: Config,
	deliver: (ref: ChatRef, text: string) => Promise<void>,
	injectContext?: (ref: ChatRef, content: string) => Promise<void>,
): NodeJS.Timeout {
	const nextRun = new Map<string, number>();
	// Initialize to startup time: a fresh start after today's `at` has already
	// passed does NOT fire retroactively — catch-up only covers gaps while running.
	let lastCheck = new Date();
	return setInterval(
		() => {
			const now = new Date();
			const prev = lastCheck;
			lastCheck = now;
			for (const sched of listSchedules() satisfies Schedule[]) {
				const key = sched.name;
				let due = false;
				if (sched.every) {
					const interval = parseEvery(sched.every);
					if (Number.isNaN(interval)) {
						console.error(`Schedule "${sched.name}" has invalid every "${sched.every}"; skipped`);
						continue;
					}
					const last = nextRun.get(key) ?? now.getTime(); // first tick runs immediately
					due = now.getTime() >= last;
					if (due) nextRun.set(key, now.getTime() + interval);
				} else if (sched.at) {
					due = crossedDailyTime(prev, now, sched.at);
				} else {
					console.error(`Schedule "${sched.name}" has neither every nor at; skipped`);
					continue;
				}
				if (!due) continue;
				console.log(`schedule ${sched.name} firing`);
				const ref = scheduleChatRef(sched);
				runOneShot(
					config,
					"You are completing a scheduled background task. Produce the requested output as concise plain text suitable for a chat message.",
					sched.prompt,
					{ tools: ["read", "bash"] },
				)
					.then(async (text) => {
						await deliver(ref, text);
						await injectResult(sched, text, injectContext);
					})
					.catch((err) => {
						console.error(`schedule ${sched.name} failed:`, err);
						void deliver(ref, `Scheduled task "${sched.name}" failed: ${err}`).catch(() => {});
					});
			}
		},
		60_000,
	);
}