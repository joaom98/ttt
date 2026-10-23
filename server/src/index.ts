// Entry point: `npm run dev` (restarts on file changes) or `npm start`.
//
// Environment variables:
//   PORT      port to listen on (default 3000)
//   HOST      interface to bind (default 0.0.0.0 so friends on your network / a tunnel can reach it)
//   DATA_DIR  where games are saved (default ./data). Games survive restarts.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createApp } from "./app.ts";
import { GameStore } from "./store.ts";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const dataDir = resolve(rootDir, process.env.DATA_DIR ?? "data");

const store = new GameStore({ dataDir });
const server = createApp(store, rootDir);
const ticker = setInterval(() => {
  store.runDueTicks();
  store.runBots();
}, 1000);

server.listen(port, host, () => {
  console.log(`Tank Turn Tactics running at http://localhost:${port}`);
  console.log(`Saving games to ${dataDir}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(ticker);
    server.close();
    server.closeAllConnections();
    process.exit(0);
  });
}
