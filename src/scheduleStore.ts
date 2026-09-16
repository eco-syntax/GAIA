import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureStateDir, stateDir, type Schedule } from "./config.js";

// ============================================================================
// Live schedule registry. Schedules live in ~/.pi-gateway/schedules.json and are
// read fresh by the scheduler every tick, so the agent can add/remove them at
// runtime without a gateway restart.
// ============================================================================

const SCHEDULES_FILE = join(stateDir, "schedules.json");

let schedules: Schedule[] = [];

/** Load the persisted registry into memory at boot. */
export function loadSchedules(): void {
	try {
		const raw = JSON.parse(readFileSync(SCHEDULES_FILE, "utf8")) as Schedule[];
		schedules = Array.isArray(raw) ? raw : [];
	} catch {
		schedules = [];
	}
}

/** Parse an interval like "30m", "2h", "1d" into milliseconds. NaN if invalid. */
export function parseEvery(every: string): number {
	const m = /^(\d+)([mhd])$/.exec(every);
	if (!m) return NaN;
	const n = Number(m[1]);
	return n * (m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000);
}

/** Parse a daily "HH:MM" time (24h). Returns {h, min} or null if invalid. */
export function parseAt(at: string): { h: number; min: number } | null {
	const m = /^(\d{1,2}):(\d{2})$/.exec(at);
	if (!m) return null;
	const h = Number(m[1]);
	const min = Number(m[2]);
	if (h > 23 || min > 59) return null;
	return { h, min };
}

function persist(): void {
	ensureStateDir();
	writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2) + "\n", { mode: 0o600 });
}

/** Snapshot of the live registry, optionally scoped to one chat. The scheduler
 * (needs every task) calls with no chatId; the agent tool passes the requesting
 * chat so it never sees or acts on schedules owned by other chats. */
export function listSchedules(chatId?: number): Schedule[] {
	const all = [...schedules];
	return chatId === undefined ? all : all.filter((s) => s.chatId === chatId);
}

export type AddResult = { ok: true } | { ok: false; error: string };

export function addSchedule(s: Schedule): AddResult {
	if (!s.name?.trim()) return { ok: false, error: "a name is required" };
	if (!s.prompt?.trim()) return { ok: false, error: "a prompt is required" };
	if (s.every && s.at) return { ok: false, error: "use either every or at, not both" };
	if (s.every) {
		if (Number.isNaN(parseEvery(s.every))) return { ok: false, error: `invalid interval "${s.every}" — use e.g. "30m", "2h", "1d"` };
	} else if (s.at) {
		if (!parseAt(s.at)) return { ok: false, error: `invalid time "${s.at}" — use "HH:MM" (24h)` };
	} else {
		return { ok: false, error: "specify an interval (every) or a daily time (at)" };
	}
	if (schedules.some((x) => x.name === s.name.trim())) {
		return { ok: false, error: `a schedule named "${s.name}" already exists` };
	}
	schedules.push({ ...s, name: s.name.trim(), prompt: s.prompt.trim() });
	persist();
	return { ok: true };
}

/** Remove by exact name, scoped to a chat: only a schedule owned by chatId
 * can be removed, so a chat can never delete another chat's tasks. Returns
 * true if something was removed. */
export function removeSchedule(name: string, chatId: number): boolean {
	const before = schedules.length;
	schedules = schedules.filter((s) => s.name !== name || s.chatId !== chatId);
	if (schedules.length !== before) {
		persist();
		return true;
	}
	return false;
}