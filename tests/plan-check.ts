/**
 * Self-check for the plan-mode tooling: write_plan filename sanitization
 * (path-traversal guard) and runDelegate's file-not-found path. No model
 * calls — pure logic.
 */
import { writePlanTool } from "../src/plan.js";
import { mkdirSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TMP = process.env.GAIA_STATE!;
if (!TMP) throw new Error("set GAIA_STATE to a temp dir for this test");

// runDelegate calls loadConfig, which requires at least one platform. Stub a
// minimal telegram config so the gate passes; no network is used.
import { writeFileSync } from "node:fs";
mkdirSync(TMP, { recursive: true }); // GAIA_STATE may not exist yet
writeFileSync(join(TMP, "config.json"), JSON.stringify({
	telegramBotToken: "stub",
	allowedChatIds: ["1"],
}));

// writePlanTool resolves plansDir from stateDir at import time, so we exercise
// it through its execute — it writes into TMP/plans/.
const tool = writePlanTool();
const cases: [string, string][] = [
	["add-login.md", "add-login.md"],
	["no-extension", "no-extension.md"],
	["../escape.md", "escape.md"], // basename strips the path
	["sub/dir/nested.md", "nested.md"],
	["UPPER.MD", "UPPER.md"],
];

for (const [input, expectedFile] of cases) {
	const content = `# plan: ${input}`;
	const res = await tool.execute("id", { filename: input, content });
	const text = (res.content[0] as { text: string }).text;
	if (!text.includes(expectedFile)) throw new Error(`write_plan(${input}): expected ${expectedFile} in ${text}`);
	const written = readFileSync(join(TMP, "plans", expectedFile), "utf8");
	if (written !== content) throw new Error(`write_plan(${input}): content mismatch`);
}

// runDelegate with a missing file returns the helpful error (no throw).
const { runDelegate } = await import("../src/session.js");
const { loadConfig } = await import("../src/config.js");
const cfg = loadConfig();
const out = await runDelegate(cfg, "does-not-exist.md");
if (!out.includes("Could not read plan file")) throw new Error(`runDelegate missing-file path broke: ${out}`);

// runDelegate with a real plan file runs a model turn — skip unless a model
// is reachable. Gate it on a marker env var so CI doesn't need a provider.
if (process.env.RUN_DELEGATE_MODEL) {
	writeFileSync(join(TMP, "plans", "echo.md"), "# Echo plan\n\nPrint the word hello and exit.");
	const impl = await runDelegate(cfg, "echo.md");
	if (impl.includes("Could not read")) throw new Error(`delegate should have run: ${impl}`);
	console.log("delegate model run produced:", impl.slice(0, 100));
}

// Cleanup.
rmSync(join(TMP, "plans"), { recursive: true, force: true });

console.log("plan-mode self-checks passed");
