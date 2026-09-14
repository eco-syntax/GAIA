try { await import("./src/index.js"); } catch (e) {
  if (!String((e as Error).message).includes("TELEGRAM_BOT_TOKEN")) throw e;
}
console.log("modules import cleanly");
