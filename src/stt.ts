import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Local STT via whisper.cpp. Telegram voices arrive as OGG/Opus; whisper.cpp
 * wants 16 kHz mono WAV, so ffmpeg converts first. The binary is `whisper-cli`
 * on upstream whisper.cpp builds, `whisper` on some distro packages.
 */
const BIN_CANDIDATES = ["whisper-cli", "whisper"];

function findBin(): string | null {
	for (const bin of BIN_CANDIDATES) {
		if (!spawnSync(bin, ["--help"], { stdio: "ignore" }).error) return bin;
	}
	return null;
}

export async function transcribe(ogg: Buffer, modelPath: string): Promise<string> {
	const bin = findBin();
	if (!bin) throw new Error("whisper.cpp binary not found (need whisper-cli or whisper on PATH)");
	const dir = mkdtempSync(join(tmpdir(), "pi-stt-"));
	try {
		const oggPath = join(dir, "in.ogg");
		const wav = join(dir, "in.wav");
		await writeFile(oggPath, ogg);
		await execFileAsync("ffmpeg", ["-y", "-i", oggPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
		// -nt: no timestamps, -np: no progress spam
		const { stdout } = await execFileAsync(bin, ["-m", modelPath, "-f", wav, "-nt", "-np"], {
			maxBuffer: 10 * 1024 * 1024,
		});
		return stdout.replace(/\s+/g, " ").trim();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Check binary + model availability once at startup. */
export function sttAvailable(modelPath: string): boolean {
	return findBin() !== null && existsSync(modelPath);
}
