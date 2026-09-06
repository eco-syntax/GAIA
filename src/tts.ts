import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Local TTS via piper. `piperVoice` is the path to a .onnx voice model
 * (e.g. /opt/piper/voices/en_US-lessac-medium.onnx). Requires the piper
 * binary on PATH. Piper emits WAV; Telegram voices want OGG/Opus, so we
 * convert with ffmpeg when available and fall back to sending WAV.
 */
export async function synthesize(text: string, voicePath: string): Promise<{ data: Buffer; mime: string }> {
	const dir = mkdtempSync(join(tmpdir(), "pi-tts-"));
	const wav = join(dir, "out.wav");
	const txt = join(dir, "in.txt");
	await writeFile(txt, text.slice(0, 4000));
	try {
		await new Promise<void>((resolve, reject) => {
			const p = spawn("piper", ["--model", voicePath, "--output_file", wav]);
			p.on("error", reject);
			p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`piper exited ${code}`))));
			p.stdin.end(text.slice(0, 4000));
		});
		const ogg = join(dir, "out.ogg");
		try {
			await execFileAsync("ffmpeg", ["-y", "-i", wav, "-c:a", "libopus", "-b:a", "32k", ogg]);
			return { data: await readFile(ogg), mime: "audio/ogg" };
		} catch {
			return { data: await readFile(wav), mime: "audio/wav" };
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Check piper + voice model availability once at startup. */
export function ttsAvailable(voicePath: string): boolean {
	try {
		const r = spawnSync("piper", ["--version"], { stdio: "ignore" });
		if (r.error) throw r.error;
		const dir = voicePath.replace(/[/\\][^/\\]+$/, "");
		return readdirSync(dir).length > 0;
	} catch {
		return false;
	}
}
