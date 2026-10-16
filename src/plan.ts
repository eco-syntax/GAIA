import { Type } from "@sinclair/typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stateDir } from "./config.js";

/** Where plan-mode sessions persist plans for /delegate to pick up. */
export const plansDir = join(stateDir, "plans");

/** Steering injected into the live session when plan mode is entered. */
export const PLAN_PROMPT = `[PLAN MODE]
You are in plan mode — a read-only exploration and planning mode. Explore the
codebase (read files, search, run read-only bash), discuss the approach, and
refine the plan through conversation. Do NOT implement anything yet.

The goal is to produce a concise, decision-complete plan and persist it as a
markdown file with the write_plan tool. The plan will be implemented either
in-session (/act) or by a fresh delegated session (/delegate <file>), so it
must stand alone — no decisions left to the implementer.

Iterate with the user until the plan is agreed, then write it to disk with
write_plan. You can revise it (re-run write_plan with the same filename).`;

/** Steering injected when act mode is entered (plan → implement, same session). */
export const ACT_PROMPT = `[ACT MODE]
You are in act mode — implement the agreed plan. Bash is approved and file
writes are enabled. Make the changes, run tests or builds if available, and
report what you did. The plan was discussed and agreed in the conversation
above; refer back to it if you need to recall a decision.`;

/** Steering injected when any mode is exited, so the model stops biasing toward
 * "plan the work" or "implement the plan" on subsequent default-mode turns. */
export const MODE_ENDED = `[MODE ENDED]
You are back in normal mode. The plan/act steering no longer applies — respond
to the user's current request normally.`;

/**
 * A write tool scoped to the plans directory, so a plan-mode session can
 * persist its plan without gaining arbitrary file-write access. Mirrors
 * OpenCode's plan-file exception (.opencode/plans/*.md) without re-enabling
 * the ungated built-in write tool (which CHAT_EXCLUDED_TOOLS exists to deny).
 */
export function writePlanTool(): ToolDefinition {
	return defineTool({
		name: "write_plan",
		label: "write_plan",
		description:
			"Write a plan markdown file to the plans directory. Use in plan mode to persist the agreed plan so it can be implemented later (/act in-session, or /delegate <file> in a fresh session). Pass the full plan content in markdown.",
		parameters: Type.Object({
			filename: Type.String({ description: "Plan filename, e.g. 'add-login.md' (the .md extension is added if missing; path components are stripped)." }),
			content: Type.String({ description: "Full plan content in markdown." }),
		}),
		async execute(_id, { filename, content }) {
			mkdirSync(plansDir, { recursive: true, mode: 0o700 });
			// ponytail: basename only — no subdirs, no path traversal. A plans/
			// subdir isn't needed yet; add when plan counts make browsing painful.
			const safe = basename(filename).replace(/\.md$/i, "") + ".md";
			writeFileSync(join(plansDir, safe), content, { mode: 0o600 });
			return {
				content: [{ type: "text" as const, text: `Plan written to ${safe}.\n\nImplement it with /act (same session) or /delegate ${safe} (fresh session).` }],
				details: undefined,
			};
		},
	});
}
