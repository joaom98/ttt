# Tank Turn Tactics

An online take on *Tank Turn Tactics*, the Halfbrick prototype where every player gets action points on
a real-time clock and spends them to move, shoot, trade and scheme. Last tank standing wins. Built as an
ice-breaker to playtest with friends, with public lobbies as the long-term goal.

See [RULES.md](RULES.md) for how the game plays.

## Setup

You need **Node.js 22.18 or newer** (check with `node -v`). That's it — the game has **no runtime
dependencies** and no build step: Node runs the TypeScript directly, and the server strips types from the
client files on the fly.

```bash
git clone https://github.com/joaom98/ttt.git
cd ttt
npm run dev
```

Open <http://localhost:3000> and click **Practice vs bots** to jump straight into a Quick game against three
bots. Or create a game, add bots from the lobby, and open the share link in private/incognito windows to join
as other players. In Quick games the host has a **Force tick** button so you don't have to wait for AP.

Every game has a text chat: messages to **Everyone**, or private messages to one player (pick them in the
chat's recipient menu, or click their tank and hit **Message privately**) for secret deals.

`npm install` is optional: it only installs TypeScript for `npm run typecheck`.

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the server and restart it when a server or rules file changes. Client files are re-served on every refresh. |
| `npm test` | Run the rules and server tests (Node's built-in test runner). |
| `npm run test:watch` | Same, re-running on every save. Best loop for tweaking rules. |
| `npm run typecheck` | Type-check everything (needs `npm install` once). |
| `npm start` | Run without file watching (for hosting). |

Environment variables: `PORT` (default 3000), `HOST` (default `0.0.0.0`), `DATA_DIR` (default `./data`).
Games are saved to `DATA_DIR` as JSON, so they survive restarts — delete the folder to wipe them.

## Project layout

```
shared/src/      game rules — pure functions used by both server and browser
  types.ts       GameState, Tank, Action, GameConfig
  config.ts      default rules and the pace presets (classic / evening / quick)
  rules.ts       applyAction(state, action) -> new state | error   ← most iteration happens here
  view.ts        what each player is allowed to see (jury votes stay secret)
shared/test/     rules tests
server/src/      HTTP API, live updates (server-sent events), tick clock, chat, saving games
  bots.ts        rule-based bot players (hunter / turtle / wildcard)
server/test/     API and bot tests
client/          the browser UI (plain TypeScript + CSS, no framework)
  src/fx.ts      action animations (slides, shots, range buffs), driven by the action behind each update
```

How a move flows: the browser POSTs an action → the server runs it through `applyAction` with the
player id taken from their secret token → saves the game → pushes the new state to everyone's
event stream → each browser re-renders. The browser uses the same `canApply` to decide which squares
and buttons to enable, so the UI and the server always agree on what's legal.

## Iterating on the game

- **Change a rule:** edit `shared/src/rules.ts`, add or adjust a test in `shared/test/rules.test.ts`,
  keep `npm run test:watch` running. The server restarts by itself under `npm run dev`.
- **Add a rule switch** (so you can A/B it in playtests): add a field to `GameConfig` in `types.ts`, a
  default in `config.ts`, use it in `rules.ts`, and add a field to the "Rule tweaks" form in
  `client/src/main.ts`.
- **Change the pace presets:** `PRESETS` in `shared/src/config.ts`.
- **Change the UI:** `client/src/main.ts` and `client/style.css` — just refresh the browser.
- **Change how bots play:** `chooseBotAction` in `server/src/bots.ts`. Bots only ever send normal player
  actions, so they can't break the rules.

## Playtesting with friends

Matches are meant to be short — one sitting, Quick pace — so nothing needs to survive a restart.

**The website (Render, free):** `render.yaml` describes the service. One-time setup:

1. Sign up at <https://render.com> with your GitHub account.
2. **New → Blueprint**, pick the `ttt` repository, and confirm. Render builds it and gives you a
   `https://tank-turn-tactics….onrender.com` address to share.
3. From then on, every push to `main` redeploys automatically.

The free plan sleeps after ~15 minutes without visitors; the first visit after that takes about a minute
to wake up. A redeploy or a sleep ends any game in progress, so don't push mid-match.

**From your own computer:** run `npm start`, then expose port 3000 with a
[Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/):

```bash
cloudflared tunnel --url http://localhost:3000
```

Share the printed `https://….trycloudflare.com` link. Your computer has to stay on for the game.

## Roadmap ideas

- Public lobbies with matchmaking (the open-lobby list is already there) — consider Colyseus or a
  database once there are many concurrent games.
- Accounts instead of per-browser tokens; notifications when AP arrives.
- Randomised tick time each day (the original moved the AP drop to stop people camping the clock).
- A Claude-powered bot that negotiates in chat (the bot hook in `server/src/bots.ts` is where it would go).
- More ice-breaker games reusing the same lobby + live-state plumbing.
