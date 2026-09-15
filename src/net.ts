/**
 * Shared network helpers: transient-error detection + retry with backoff,
 * used by every chat-platform transport (Telegram, Slack, Discord, Matrix).
 * index.ts installs an undici EnvHttpProxyAgent honoring HTTP(S)_PROXY, which
 * the fetch calls here inherit.
 */

export const RETRYABLE_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"EPIPE",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"ENOTFOUND",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET",
	"UND_ERR_CLOSED",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
]);

/** Walk the error/cause chain for a transport error code (undici nests causes). */
export function errorCode(err: unknown): string | undefined {
	let e = err;
	for (let i = 0; e && i < 6; i++) {
		const code = (e as { code?: unknown }).code;
		if (typeof code === "string") return code;
		e = (e as { cause?: unknown }).cause;
	}
	return undefined;
}

export function isTransient(err: unknown): boolean {
	const code = errorCode(err);
	if (code && RETRYABLE_CODES.has(code)) return true;
	const status = (err as { errorCode?: number; status?: number } | undefined)?.errorCode
		?? (err as { status?: number } | undefined)?.status;
	if (status === 429 || (status !== undefined && status >= 500)) return true;
	return err instanceof TypeError && /fetch failed|terminated|other side closed|socket hang up/i.test(err.message);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
	});
}

/** Retry a network operation on transient failures with backoff. Honors an
 * AbortSignal (shutdown) and a 429 `retryAfter` hint. */
export async function retry<T>(label: string, fn: () => Promise<T>, signal?: AbortSignal, attempts = 4): Promise<T> {
	let last: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			last = err;
			if (signal?.aborted || !isTransient(err) || attempt === attempts - 1) throw err;
			const retryAfter = (err as { retryAfter?: number }).retryAfter;
			const delay = (retryAfter ? retryAfter * 1000 : 400 * 2 ** attempt) + Math.random() * 200;
			console.warn(`${label}: transient network error (${errorCode(err) ?? "unknown"}), retrying in ${Math.round(delay)}ms`);
			await sleep(delay, signal);
		}
	}
	throw last;
}

/** fetch + JSON decode + retry on transient failures. Throws on non-2xx. */
export async function fetchJson<T = unknown>(
	url: string,
	init: RequestInit = {},
	label = "fetch",
	signal?: AbortSignal,
): Promise<T> {
	return retry(label, async () => {
		const res = await fetch(url, init);
		if (!res.ok) {
			const err = new Error(`${label}: HTTP ${res.status}`) as Error & {
				errorCode?: number;
				status?: number;
				retryAfter?: number;
			};
			err.errorCode = res.status;
			err.status = res.status;
			err.retryAfter = Number(res.headers.get("retry-after") ?? 0) || undefined;
			throw err;
		}
		return (await res.json()) as T;
	}, signal);
}