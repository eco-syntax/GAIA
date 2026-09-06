import type { Schedule } from "./config.js";
import { runOneShot } from "./session.js";
import type { Config } from "./config.js";

/**
 * Scheduled tasks: each entry is just {cron-ish, chatId, prompt}. The gateway
 * runs a headless pi turn and delivers the text to the chat. No job types, no
 * DSL — the prompt IS the task.
 */

function parseEvery(every: string): number {
	const m = /^(\d+)([mhd])$/.exec(every);
	if (!m) throw new Error(`Invalid schedule interval: ${every} (use e.g. "30m", "2h", "1d")`);
	const n = Number(m[1]);
	return n * (m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000);
}

/** Whether the daily `at: "HH:MM"` time fell in (prev, now] — catches ticks skipped by event-loop stalls or suspend/resume. */
export function crossedDailyTime(prev: Date, now: Date, at: string): boolean {
	const [h, min] = at.split(":").map(Number);
	const atToday = new Date(now);
	atToday.setHours(h!, min!, 0, 0);
	return atToday > prev && atToday <= now;
}

export function startScheduler(
	config: Config,
	deliver: (chatId: number, text: string) => Promise<void>,
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
			for (const sched of config.schedules satisfies Schedule[]) {
				const key = sched.name;
				let due = false;
				if (sched.every) {
					const interval = parseEvery(sched.every);
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
				runOneShot(
					config,
					"You are completing a scheduled background task. Produce the requested output as concise plain text suitable for a chat message.",
					sched.prompt,
					{ tools: ["read", "bash"] },
				)
					.then((text) => deliver(sched.chatId, text))
					.catch((err) => {
						console.error(`schedule ${sched.name} failed:`, err);
						void deliver(sched.chatId, `Scheduled task "${sched.name}" failed: ${err}`).catch(() => {});
					});
			}
		},
		60_000,
	);
}
