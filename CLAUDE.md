# Notes for working on this repo

- Online Tank Turn Tactics for playtesting with friends; public lobbies are a later goal. README.md
  covers setup and layout, RULES.md the game rules — keep RULES.md in sync with `shared/src/rules.ts`.
- Zero runtime dependencies on purpose: Node ≥ 22.18 runs `.ts` files directly (type stripping), and
  `server/src/static.ts` strips types from client/shared files on request. Only erasable TypeScript is
  allowed (no enums, namespaces or constructor parameter properties) — `tsconfig.json` enforces
  `erasableSyntaxOnly`. Import local files with the `.ts` extension.
- `shared/src/rules.ts` is a pure reducer: never mutate the input, use the seeded `Rng` (state.rng) for
  randomness, take time from actions (`now`), not `Date.now()` (log timestamps are the one exception).
  Every rule change needs a test in `shared/test/rules.test.ts`.
- The server is authoritative; the player id always comes from the token, never the request body.
- Commands: `npm test`, `npm run typecheck` (after `npm install`), `npm run dev` (port 3000).
