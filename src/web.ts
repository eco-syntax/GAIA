import { Type } from "@sinclair/typebox";
import { Agent, fetch, type Response } from "undici";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import dns from "node:dns";
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { join } from "node:path";
import { stateDir, ensureStateDir } from "./config.js";

// ============================================================================
// Hermes-style web search + fetch: one tool, zero user configuration.
// Search: DuckDuckGo HTML endpoint (no API key). Fetch: readability-ish
// HTML-to-text. Both are deliberately crude and bounded — they exist to feed
// a model a compact result, not to be a browser.
// ============================================================================

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36";
const FETCH_CHAR_LIMIT = 20_000;
/** Where truncated fetchpage results are saved so the model can read the full text. */
const researchDir = join(stateDir, "research");
/** Hard cap on any buffered/persisted response body (memory + research dir). */
export const MAX_BODY_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;

// ============================================================================
// SSRF guard: only allow http(s) to public hosts. DNS is resolved and every
// answer must be a public address; redirects are followed manually so each hop
// is re-validated. A custom connect lookup re-checks the address the socket is
// actually opened against, which closes the DNS-rebinding (TOCTOU) window.
// ============================================================================

// Non-public destinations, encoded as CIDRs in Node's built-in net.BlockList
// (the same ranges the previous hand-rolled table/parser covered).
const privateBlockList = new BlockList();
privateBlockList.addSubnet("0.0.0.0", 8, "ipv4"); // "this network"
privateBlockList.addSubnet("10.0.0.0", 8, "ipv4"); // private
privateBlockList.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
privateBlockList.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
privateBlockList.addSubnet("169.254.0.0", 16, "ipv4"); // link-local / cloud metadata
privateBlockList.addSubnet("172.16.0.0", 12, "ipv4"); // private
privateBlockList.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments
privateBlockList.addSubnet("192.0.2.0", 24, "ipv4"); // TEST-NET-1
privateBlockList.addSubnet("192.88.99.0", 24, "ipv4"); // 6to4 relay
privateBlockList.addSubnet("192.168.0.0", 16, "ipv4"); // private
privateBlockList.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
privateBlockList.addSubnet("198.51.100.0", 24, "ipv4"); // TEST-NET-2
privateBlockList.addSubnet("203.0.113.0", 24, "ipv4"); // TEST-NET-3
privateBlockList.addSubnet("224.0.0.0", 3, "ipv4"); // multicast (224/4) + reserved (240/4)
privateBlockList.addSubnet("::", 128, "ipv6");
privateBlockList.addSubnet("::1", 128, "ipv6");
privateBlockList.addSubnet("fe80::", 10, "ipv6"); // link-local
privateBlockList.addSubnet("fc00::", 7, "ipv6"); // unique-local
privateBlockList.addSubnet("ff00::", 8, "ipv6"); // multicast

/**
 * Extract the embedded IPv4 from an IPv4-mapped (::ffff:0:0/96) or 6to4
 * (2002::/16) address so it can be checked against the IPv4 ranges; null for
 * any other IPv6 literal.
 */
function unwrapIPv4(ip: string): string | null {
	const bare = ip.split("%")[0]!.toLowerCase();
	const mapped = /^::ffff:(.+)$/.exec(bare);
	if (mapped) {
		const v4 = mapped[1]!;
		if (v4.includes(".")) return v4;
		const [hi = "0", lo = "0"] = v4.split(":");
		return `${parseInt(hi, 16) >> 8}.${parseInt(hi, 16) & 0xff}.${parseInt(lo, 16) >> 8}.${parseInt(lo, 16) & 0xff}`;
	}
	const t = /^2002:(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,4})?/.exec(bare);
	if (t) {
		const hi = t[1] ? parseInt(t[1]!, 16) : 0;
		const lo = t[2] ? parseInt(t[2]!, 16) : 0;
		return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
	}
	return null;
}

export function isPrivateAddress(ip: string): boolean {
	const bare = ip.replace(/^\[|\]$/g, "");
	const family = isIP(bare);
	if (family === 4) return privateBlockList.check(bare, "ipv4");
	if (family === 6) {
		const v4 = unwrapIPv4(bare);
		if (v4) return privateBlockList.check(v4, "ipv4");
		return privateBlockList.check(bare, "ipv6");
	}
	return true; // not an IP — treat as unsafe
}

async function assertPublicHostname(hostname: string): Promise<void> {
	const bare = hostname.replace(/^\[|\]$/g, "");
	if (isIP(bare)) {
		if (isPrivateAddress(bare)) throw new Error(`blocked non-public address ${bare}`);
		return;
	}
	let addresses: { address: string; family: number }[];
	try {
		addresses = await lookup(hostname, { all: true });
	} catch {
		throw new Error(`could not resolve host ${hostname}`);
	}
	if (addresses.length === 0) throw new Error(`could not resolve host ${hostname}`);
	for (const { address } of addresses) {
		if (isPrivateAddress(address)) throw new Error(`host ${hostname} resolves to non-public address ${address}`);
	}
}

async function assertSafeUrl(raw: string): Promise<URL> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`invalid URL: ${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`blocked scheme ${url.protocol}`);
	await assertPublicHostname(url.hostname);
	return url;
}

// Reject private addresses at connect time, even if DNS changed after validation.
const ssrfLookup: LookupFunction = (hostname, options, callback) => {
	dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
		if (err) return callback(err, "", 0);
		const list = addresses as { address: string; family: number }[];
		const bad = list.find((a) => isPrivateAddress(a.address));
		if (bad) return callback(new Error(`blocked non-public address ${bad.address} for ${hostname}`), "", 0);
		if (options.all) return callback(null, list, 0);
		const first = list[0]!;
		callback(null, first.address, first.family);
	});
};

const ssrfAgent = new Agent({ connect: { lookup: ssrfLookup } });

async function safeFetch(url: string): Promise<Response> {
	let current = await assertSafeUrl(url);
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const res = await fetch(current, { headers: { "user-agent": UA }, redirect: "manual", dispatcher: ssrfAgent });
		const location = res.headers.get("location");
		const isRedirect = res.status >= 300 && res.status < 400 && location;
		if (!isRedirect) return res;
		await res.body?.cancel();
		if (hop === MAX_REDIRECTS) break;
		current = await assertSafeUrl(new URL(location, current).toString());
	}
	throw new Error(`too many redirects fetching ${url}`);
}

/**
 * Drain a response body with a hard byte cap. Rejects up-front when
 * Content-Length exceeds the cap and stops mid-stream once the cap is hit, so
 * an attacker-controlled multi-GB page can neither OOM the process nor fill
 * the state disk. Returns the bytes read and whether the cap was hit.
 */
export async function readBodyLimited(res: Response): Promise<{ buf: Buffer; truncated: boolean }> {
	const declared = res.headers.get("content-length");
	if (declared) {
		const n = Number(declared);
		if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
			await res.body?.cancel();
			throw new Error(`response too large: ${n} bytes (limit ${MAX_BODY_BYTES})`);
		}
	}
	const body = res.body;
	if (!body) return { buf: Buffer.alloc(0), truncated: false };
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > MAX_BODY_BYTES) {
				await reader.cancel(); // stop draining the socket once the cap is hit
				return { buf: Buffer.concat(chunks), truncated: true };
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return { buf: Buffer.concat(chunks), truncated: false };
}

function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<nav[\s\S]*?<\/nav>/gi, "")
		.replace(/<footer[\s\S]*?<\/footer>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

async function webSearch(query: string): Promise<SearchResult[]> {
	const res = await fetch("https://html.duckduckgo.com/html/", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
		body: new URLSearchParams({ q: query }),
	});
	const { buf } = await readBodyLimited(res);
	const html = buf.toString("utf8");
	const results: SearchResult[] = [];
	const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
	const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
	const urls: string[] = [];
	const titles: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = linkRe.exec(html)) && urls.length < 8) {
		// DDG wraps target URLs in a redirect: //duckduckgo.com/l/?uddg=<encoded>&...
		const uddg = new URL(`https:${m[1]}`).searchParams.get("uddg");
		urls.push(uddg ? decodeURIComponent(uddg) : m[1]!);
		titles.push(htmlToText(m[2]!));
	}
	const snippets: string[] = [];
	while ((m = snippetRe.exec(html)) && snippets.length < 8) snippets.push(htmlToText(m[1]!));
	for (let i = 0; i < urls.length; i++) {
		results.push({ title: titles[i] ?? "", url: urls[i]!, snippet: snippets[i] ?? "" });
	}
	return results;
}

export function webTools(onAccess?: () => void): ToolDefinition[] {
	const search: ToolDefinition = defineTool({
		name: "websearch",
		label: "Web search",
		description:
			"Search the web. Returns up to 8 results with title, url, and snippet. Use fetchpage for full content of a promising result.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
		}),
		async execute(_id, params) {
			onAccess?.(); // taint the session: web results are untrusted
			const results = await webSearch(params.query);
			if (results.length === 0) return { content: [{ type: "text" as const, text: "No results." }], details: undefined };
			const text = results
				.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
				.join("\n\n");
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});

	const fetchpage: ToolDefinition = defineTool({
		name: "fetchpage",
		label: "Fetch page",
		description:
			`Fetch a web page and return its readable text (first ${FETCH_CHAR_LIMIT} characters). Longer pages are saved to disk (capped at ${MAX_BODY_BYTES} bytes); the tool result is capped so the conversation stays small.`,
		parameters: Type.Object({
			url: Type.String({ description: "Page URL" }),
		}),
		async execute(_id, params) {
			onAccess?.(); // taint the session: web content is untrusted
			// Exfiltration guard: a URL can smuggle data to a public server in the
			// query string (?<secret>=<data>), in the path (https://a/<SECRET>), or
			// in the fragment (#<SECRET>). fetchpage exists to read a page's content,
			// not to emit parameters, so refuse any URL that is not a bare site
			// origin — no path, no query, no fragment. websearch posts its query in
			// the request body, so search is unaffected; and the session's built-in
			// read tool is excluded (src/session.ts) so the model has no secret source
			// to leak in the first place. A user-supplied page URL that isn't a bare
			// origin is still reachable via the base URL (and redirects are
			// re-validated).
			try {
				const parsed = new URL(params.url);
				if (parsed.search || parsed.hash || parsed.pathname !== "/") {
					const carrying =
						parsed.search ||
						(parsed.pathname !== "/" ? `path ${parsed.pathname}` : `fragment ${parsed.hash}`);
					return {
						content: [
							{
								type: "text" as const,
								text: `Refused to fetch ${params.url}: URL carries a ${carrying}, which a page could use to smuggle data to a remote server. Fetch the bare origin only (https://<host>), or ask the user to approve the full URL.`,
							},
						],
						details: undefined,
					};
				}
			} catch {
				// not a valid URL — let safeFetch give the canonical error below
			}
			let res: Response;
			try {
				res = await safeFetch(params.url);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text" as const, text: `Cannot fetch ${params.url}: ${reason}` }], details: undefined };
			}
			if (!res.ok) return { content: [{ type: "text" as const, text: `HTTP ${res.status} fetching ${params.url}` }], details: undefined };
			const { buf, truncated } = await readBodyLimited(res);
			const text = htmlToText(buf.toString("utf8"));
			if (!truncated && text.length <= FETCH_CHAR_LIMIT) {
				return { content: [{ type: "text" as const, text }], details: undefined };
			}
			// Only persist pages that exceed the inline limit; short fetches never touch disk.
			ensureStateDir(); // stateDir must be owner-only before anything goes under it
			mkdirSync(researchDir, { recursive: true });
			const slug = params.url.replace(/[^a-z0-9]+/gi, "-").slice(0, 80);
			const path = join(researchDir, `${slug}.txt`);
			writeFileSync(path, text, { mode: 0o600 });
			const note = truncated
				? `\n\n[body exceeded ${MAX_BODY_BYTES} bytes; saved truncated text to ${path}]`
				: text.length > FETCH_CHAR_LIMIT
					? `\n\n[truncated; full text: ${path}]`
					: "";
			return {
				content: [{ type: "text" as const, text: `${text.slice(0, FETCH_CHAR_LIMIT)}${note}` }],
				details: undefined,
			};
		},
	});

	return [search, fetchpage];
}
