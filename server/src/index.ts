import { createApp } from "./app.ts";
import { openStore } from "./db.ts";
import { createDeliveryWorker } from "./worker.ts";

function loadMap(name: string, required: boolean): Map<string, string> {
  const raw = process.env[name];
  if (!raw) {
    if (required) throw new Error(`Set ${name} (see .env.example)`);
    return new Map();
  }
  return new Map(Object.entries(JSON.parse(raw) as Record<string, string>));
}

const port = Number(process.env.PORT ?? 4000);
const store = openStore(process.env.DATABASE_PATH ?? "hookrelay.db");
const secrets = loadMap("HOOKRELAY_SECRETS", true);
const targets = loadMap("HOOKRELAY_TARGETS", false);
const apiKey = process.env.HOOKRELAY_API_KEY;
if (!apiKey) throw new Error("Set HOOKRELAY_API_KEY (see .env.example)");
const toleranceSeconds = Number(process.env.HOOKRELAY_SIGNATURE_TOLERANCE_SECONDS ?? 300);
if (!Number.isInteger(toleranceSeconds) || toleranceSeconds < 1) {
  throw new Error("HOOKRELAY_SIGNATURE_TOLERANCE_SECONDS must be a whole number of seconds, 1 or more");
}

const worker = createDeliveryWorker({ store, secrets });
worker.start();

const server = createApp({ store, secrets, targets, apiKey, toleranceSeconds }).listen(port, () => {
  console.log(`hookrelay listening on http://localhost:${port}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await worker.stop();
  store.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
