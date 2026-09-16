import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir, type Schedule } from "./config.js";

// ============================================================================
// Live schedule registry. Schedules live in ~/.pi-gateway/schedules.json and are
// read fresh by the scheduler every tick, so the agent can add/remove them at
// runtime without a gateway restart. Seeded from config.schedules at boot so
// existing config-driven schedules keep working.
// ============================================================================

const SCHEDULES_FILE = join(stateDir, "schedules.json");

const EVERY_RE = /^(\d+)([mhd])$/;
const AT_RE = /^(\d{1,2}):(\d{2})$/;

let schedules: Schedule[] = [];

/** Seed the registry from config.schedules (only names not already persisted). */
export function initScheduleStore(seed: Schedule[]): void {
	try {
		const raw = JSON.parse(readFileSync(SCHEDULES_FILE, "utf8")) as Schedule[];
		schedules = Array.isArray(raw) ? raw : [];
	} catch {
		schedules = [];
	}
	const names = new Set(schedules.map((s) => s.name));
	for (const s of seed) {
		if (s && s.name && !names.has(s.name)) {
			schedules.push(s);
			names.add(s.name);
		}
	}
	persist();
}

function persist(): void {
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2) + "\n", { mode: 0o600 });
}

/** Snapshot of the live registry, optionally scoped to one chat. The scheduler
 * (needs every task) calls with no chatId; the agent tool passes the requesting
 * chat so it never sees or acts on schedules owned by other chats. */
export function listSchedules(chatId?: number): Schedule[] {
	const all = [...schedules];
	return chatId === undefined ? all : all.filter((s) => s.chatId === chatId);
}

function validTime(at: string): boolean {
	const m = AT_RE.exec(at);
	if (!m) return false;
	const h = Number(m[1]);
	const min = Number(m[2]);
	return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

export type AddResult = { ok: true } | { ok: false; error: string };

export function addSchedule(s: Schedule): AddResult {
	if (!s.name?.trim()) return { ok: false, error: "a name is required" };
	if (!s.prompt?.trim()) return { ok: false, error: "a prompt is required" };
	if (s.every && s.at) return { ok: false, error: "use either every or at, not both" };
	if (s.every) {
		if (!EVERY_RE.test(s.every)) return { ok: false, error: `invalid interval "${s.every}" — use e.g. "30m", "2h", "1d"` };
	} else if (s.at) {
		if (!validTime(s.at)) return { ok: false, error: `invalid time "${s.at}" — use "HH:MM" (24h)` };
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