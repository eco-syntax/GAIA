import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./config.js";
import { chatKey, type ChatMessage, type ChatRef } from "./platform.js";

// ============================================================================
// Identity bridging. A user proves they are the same authorized user on every
// chat platform with a two-step code flow (no passwords in plain text):
//   1. In a 1:1 DM: /link            → the gateway shows a one-time code.
//   2. In the other 1:1 DM you want to join: /link <code>.
// Whoever knows the code has proven access to the first chat, so the second
// chat joins the same identity. Either direction works: generate the code in
// the chat you're in, then enter it in the chat you want to link (or run
// /link there and enter the code here).
//
// Identities scope memory + recall: linked chats share one memory file and
// recall only searches those chats' logs, never anyone else's. Linking is
// deliberately restricted to 1:1 DMs — the command layer enforces `direct`,
// never group chats.
//
// Codes are single-use, expire after LINK_CODE_TTL_MS, and are drawn from an
// alphabet without ambiguous characters (0/O, 1/I/L).
// ============================================================================

const IDENTITIES_FILE = join(stateDir, "identities.json");
const LINK_CODE_TTL_MS = 10 * 60 * 1000;
/** 32 chars — 256 % 32 === 0, so randomBytes % length is perfectly uniform. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const MAX_PENDING = 50;

interface LinkedChat {
	platform: string;
	chatId: string;
	userId: string;
	name?: string;
	linkedAt: string;
}

interface Identity {
	id: string;
	chats: LinkedChat[];
}

interface PendingLink {
	code: string;
	origin: LinkedChat;
	expiresAt: number;
}

let identities: Identity[] = [];
let pendingLinks: PendingLink[] = [];
let loaded = false;

function ensureLoaded(): void {
	if (loaded) return;
	loaded = true;
	try {
		const raw = JSON.parse(readFileSync(IDENTITIES_FILE, "utf8")) as { identities?: Identity[] };
		identities = Array.isArray(raw.identities) ? raw.identities : [];
	} catch {
		identities = [];
	}
}

function persist(): void {
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(IDENTITIES_FILE, JSON.stringify({ identities }, null, 2) + "\n", { mode: 0o600 });
}

function toLinkedChat(msg: ChatMessage): LinkedChat {
	return {
		platform: msg.ref.platform,
		chatId: msg.ref.chatId,
		userId: msg.userId,
		name: msg.userName,
		linkedAt: new Date().toISOString(),
	};
}

/** The identity a chat belongs to, if any. */
export function identityForChat(ref: ChatRef): Identity | undefined {
	ensureLoaded();
	const key = chatKey(ref);
	return identities.find((id) => id.chats.some((c) => chatKey(c) === key));
}

/** The identity id a chat belongs to, if any. */
export function identityIdForChat(ref: ChatRef): string | undefined {
	return identityForChat(ref)?.id;
}

/** All chat keys (namespaced + legacy bare ids) that belong to ref's identity —
 * the scope for recall. Unlinked chats are scoped to themselves. */
export function recallChatScope(ref: ChatRef): string[] {
	const id = identityForChat(ref);
	const chats = id?.chats ?? [{ platform: ref.platform, chatId: ref.chatId, userId: "" }];
	const keys = new Set<string>();
	for (const c of chats) {
		keys.add(chatKey(c));
		keys.add(c.chatId); // legacy pre-namespaced session dirs
	}
	return [...keys];
}

function randomCode(): string {
	const bytes = randomBytes(CODE_LENGTH);
	let code = "";
	for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
	return code;
}

/** Generate a one-time link code for the given chat (must be a 1:1 DM — the
 * command layer enforces that). Reuses an unexpired code for the same chat so
 * a repeated /link doesn't invalidate the one already shown. */
export function createPendingLink(msg: ChatMessage): string {
	ensureLoaded();
	const now = Date.now();
	pendingLinks = pendingLinks.filter((p) => p.expiresAt > now);
	const key = chatKey(msg.ref);
	const origin = toLinkedChat(msg);
	const existing = pendingLinks.find((p) => chatKey(p.origin) === key);
	if (existing) {
		existing.expiresAt = now + LINK_CODE_TTL_MS;
		existing.origin = origin;
		return existing.code;
	}
	const code = randomCode();
	pendingLinks.push({ code, origin, expiresAt: now + LINK_CODE_TTL_MS });
	if (pendingLinks.length > MAX_PENDING) pendingLinks.shift();
	return code;
}

export type LinkResult = { ok: true; uid: string } | { ok: false; error: string };

/** Redeem a code in another 1:1 DM: the entering chat joins the origin chat's
 * identity, or the origin joins the entering chat's, or a fresh identity is
 * created for both. Single-use; refuses to merge two established identities
 * (that would silently expose each user's memories to the other). */
export function consumeLink(code: string, msg: ChatMessage): LinkResult {
	ensureLoaded();
	const now = Date.now();
	const idx = pendingLinks.findIndex((p) => p.code === code && p.expiresAt > now);
	if (idx === -1) {
		return { ok: false, error: "invalid or expired code — run /link in the chat you want to join from" };
	}
	const pending = pendingLinks[idx]!;
	pendingLinks.splice(idx, 1); // single use
	const originRef: ChatRef = { platform: pending.origin.platform, chatId: pending.origin.chatId };
	if (chatKey(originRef) === chatKey(msg.ref)) {
		return { ok: false, error: "that code was generated in this chat — use it in the chat you want to link" };
	}
	const idA = identityForChat(originRef);
	const idB = identityForChat(msg.ref);
	if (idA && idB && idA.id !== idB.id) {
		return { ok: false, error: "both chats are already linked to different identities — refusing to merge" };
	}
	const joined = toLinkedChat(msg);
	const target = idA ?? idB;
	if (target) {
		if (!target.chats.some((c) => chatKey(c) === chatKey(originRef))) target.chats.push(pending.origin);
		if (!target.chats.some((c) => chatKey(c) === chatKey(msg.ref))) target.chats.push(joined);
		persist();
		return { ok: true, uid: target.id };
	}
	const uid = `u${identities.length + 1}`;
	identities.push({ id: uid, chats: [pending.origin, joined] });
	persist();
	return { ok: true, uid };
}

/** Human-readable identity status for /whoami. */
export function whoami(ref: ChatRef): string {
	ensureLoaded();
	const id = identityForChat(ref);
	if (!id) {
		return "Not linked to an identity. Run /link here to get a code, then /link <code> in the chat you want to join (or the other way round). Linking works only in 1:1 DMs.";
	}
	const chats = id.chats
		.map((c) => `- ${c.platform} chat ${c.chatId}${c.name ? ` (${c.name})` : ""}`)
		.join("\n");
	return `Linked identity ${id.id}:\n${chats}\n\nThese chats share memory and recall.`;
}