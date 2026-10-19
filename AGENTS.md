<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## This repository

JewelVault's screen: a static Next.js export that talks to the JewelVault API (`jewelvault-api`). Read `README.md` and `docs/handoffs.md` (one heading per finished task) first.

- There is one kind of build. It always opens the login screen and needs `NEXT_PUBLIC_API_URL` (an origin); that is the only variable the code may read at build time (`npm run check:build` fails on any other). There is no preview or sample-data mode, no second database client and no record of the shop in the browser's storage (the hidden Order Book, `src/lib/orderStore.ts`, is the one exception).
- Money and weight cross the wire as text and are never added up here: the figures on a screen are the API's.
- Run `npm run verify` before anything is called ready; `E2E=1 LANE=<lane> JV_API_DIR=<jewelvault-api checkout> npm run verify` adds the browser tests (`tests/e2e/README.md`). Tests come first and are seen to fail for the right reason.
- Local commits only: never `git push` or `git pull`; the owner pushes by hand.
