# Notes for working on this repo

- Online Tank Turn Tactics for playtesting with friends; public lobbies are a later goal. README.md
  covers setup and layout, RULES.md the game rules — keep RULES.md in sync with `shared/src/rules.ts`.
- Matches are meant to be short (one sitting, the Quick pace is the baseline) — fixing the original's
  multi-day format is the point. Don't build for multi-day games or keeping a match alive across restarts.
  Deployed on Render's free plan via `render.yaml`.
- Bots (`server/src/bots.ts`) and chat live in the server store, not the rules reducer; bots act only
  through ordinary `PlayerAction`s.
- Zero runtime dependencies on purpose: Node ≥ 22.18 runs `.ts` files directly (type stripping), and
  `server/src/static.ts` strips types from client/shared files on request. Only erasable TypeScript is
  allowed (no enums, namespaces or constructor parameter properties) — `tsconfig.json` enforces
  `erasableSyntaxOnly`. Import local files with the `.ts` extension.
- `shared/src/rules.ts` is a pure reducer: never mutate the input, use the seeded `Rng` (state.rng) for
  randomness, take time from actions (`now`), not `Date.now()` (log timestamps are the one exception).
  Every rule change needs a test in `shared/test/rules.test.ts`.
- The server is authoritative; the player id always comes from the token, never the request body.
- Commands: `npm test`, `npm run typecheck` (after `npm install`), `npm run dev` (port 3000).
