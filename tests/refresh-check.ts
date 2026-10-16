// Self-check for /refresh: editing models.json must be picked up by the shared
// runtime without a gateway restart. Adds a sentinel model, reloads, asserts
// it appears, then restores the original file and reloads again. Run:
//   npx tsx tests/refresh-check.ts
import assert from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { ChatSessions, refreshModelCatalog } from "../src/session.js";

const modelsPath = join(homedir(), ".greenpi", "agent", "models.json");
const SENTINEL = "__refresh_check__";
const PROVIDER = "windows-lmstudio";

const config = loadConfig();
const chats = new ChatSessions(config);
const original = await readFile(modelsPath, "utf-8");

try {
	const doc = JSON.parse(original) as { providers: Record<string, { models?: { id: string }[] }> };
	doc.providers[PROVIDER]!.models ??= [];
	if (!doc.providers[PROVIDER]!.models.some((m) => m.id === SENTINEL)) {
		doc.providers[PROVIDER]!.models.push({ id: SENTINEL });
		await writeFile(modelsPath, JSON.stringify(doc, null, "\t"));
	}

	const err = await refreshModelCatalog();
	assert.ifError(err ? new Error(err) : undefined);

	const specs = (await chats.models(PROVIDER)).map((m) => m.spec);
	assert(specs.includes(`${PROVIDER}/${SENTINEL}`), `refresh did not pick up new model ${PROVIDER}/${SENTINEL}`);
	console.log("refresh-check: OK — models.json change picked up without restart");
} finally {
	await writeFile(modelsPath, original);
	await refreshModelCatalog();
}
