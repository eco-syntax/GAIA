await import("./src/session.js");
try { await import("./src/index.js"); } catch (e) {
  if (!String((e as Error).message).includes("config.json")) throw e;
}
console.log("modules import cleanly");