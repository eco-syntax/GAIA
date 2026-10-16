// Self-check for /model switching: provider/id specs with slash-containing
// model ids, bare ids, the auth gate, and error paths. Restores the previous
// model after. Run: npx tsx tests/model-check.ts
import assert from "node:assert";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig, setModel } from "../src/config.js";
import { ChatSessions } from "../src/session.js";

const config = loadConfig();
const original = config.model ? { ...config.model } : undefined;
const chats = new ChatSessions(config);
// Independent runtime only for hasConfiguredAuth checks; the gateway's own
// runtime (inside ChatSessions) reads the same auth.json / env keys.
const runtime = await ModelRuntime.create({ allowModelNetwork: true });

try {
	const specs: string[] = [];
	for (const p of await chats.providers()) for (const m of await chats.models(p)) specs.push(m.spec);
	assert(specs.length > 0, "model catalog must not be empty");

	// switchModel is auth-gated: only providers with configured auth accept a
	// switch. Without one here, only the error paths below are testable.
	const authed = specs.filter((s) => runtime.hasConfiguredAuth(s.slice(0, s.indexOf("/"))));
	const slashed = authed.find((s) => s.slice(s.indexOf("/") + 1).includes("/"));
	const target = slashed ?? authed[0];

	if (target) {
		// Full "provider/id" spec round-trips. A slash-containing id (e.g.
		// lmstudio/unsloth/gemma-...) proves the provider boundary is the slash
		// prefix that names a known provider.
		assert.equal(await chats.switchModel(target), null);
		assert.equal(await chats.currentModel(), target);

		// Bare model id (what a user types after copying a model name) resolves.
		const bare = target.slice(target.indexOf("/") + 1);
		const bareResult = await chats.switchModel(bare);
		if (bareResult === null) assert.equal(await chats.currentModel(), target);
		else assert.match(bareResult, /matches/); // ambiguous across providers is fine

		// An unauth'd provider is refused before persisting: config untouched.
		const unauthed = specs.find((s) => !runtime.hasConfiguredAuth(s.slice(0, s.indexOf("/"))));
		if (unauthed) {
			assert.match((await chats.switchModel(unauthed))!, /No API key/);
			assert.equal(await chats.currentModel(), target);
		}
	}

	// Unknown specs error instead of throwing.
	assert.match((await chats.switchModel("no-such-provider/nope"))!, /No model or provider/);
	assert.match((await chats.switchModel("%%"))!, /No model or provider/);
} finally {
	if (original) setModel(config, original);
}
console.log("model-check: all assertions passed");