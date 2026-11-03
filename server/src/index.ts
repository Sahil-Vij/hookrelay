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

const worker = createDeliveryWorker({ store, secrets });
worker.start();

const server = createApp({ store, secrets, targets }).listen(port, () => {
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
