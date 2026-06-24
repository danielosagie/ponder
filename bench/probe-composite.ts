import { config as loadDotenv } from "dotenv";
loadDotenv({ path: require("node:path").join(__dirname, "..", ".env") });
(async () => {
  const { makeProvider, computeDefaultProvider, humanProviderLabel } = await import(
    "/Users/dosagie/Documents/CodeProjects/holo3-agent/src/agent/factory"
  );
  const p = makeProvider(computeDefaultProvider());
  console.log(`provider.name=${p.name} label="${humanProviderLabel(p.name)}" hasStep=${typeof p.step === "function"} hasGroundBatch=${typeof p.groundBatch === "function"}`);
  const r = await p.plan({
    task: "The screen shows a dialog with an OK button. Goal: dismiss the dialog.",
    history: ["click the Cancel button  [note: failed — element not found]"],
    screenshotB64: "",
    screen: [1512, 982],
  });
  console.log(`plan → "${r.action}"`);
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e?.message ?? e); process.exit(1); });
