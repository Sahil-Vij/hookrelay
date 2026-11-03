import { createApp } from "./app.ts";
import { openStore } from "./db.ts";

function loadSecrets(): Map<string, string> {
  const raw = process.env.HOOKRELAY_SECRETS;
  if (!raw) throw new Error("Set HOOKRELAY_SECRETS (see .env.example)");
  return new Map(Object.entries(JSON.parse(raw) as Record<string, string>));
}

const port = Number(process.env.PORT ?? 4000);
const store = openStore(process.env.DATABASE_PATH ?? "hookrelay.db");
createApp({ store, secrets: loadSecrets() }).listen(port, () => {
  console.log(`hookrelay listening on http://localhost:${port}`);
});
