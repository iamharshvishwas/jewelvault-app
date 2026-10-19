# JewelVault

Jewellery inventory, barcode and billing software for Jaishri Gold Palace Pvt Ltd. It is a static Next.js 16 site (React 19, Tailwind CSS 3), the screen of the JewelVault API (the `jewelvault-api` repository). The site signs in at the API, reads the shop's data into memory and saves every change through the API; it keeps none of the shop's records in the browser (the hidden Order Book screen, which no menu lists, is the one exception), and there is no preview or sample-data mode: a build always opens the login screen.

## Requirements

Node.js 20.9 or newer.

## Commands

```bash
npm install          # install dependencies (no browser is downloaded)
npm run dev          # dev server on http://localhost:4028
npm test             # unit tests (Vitest 3.2)
npm run typecheck    # next typegen + tsc --noEmit
npm run lint         # ESLint (flat config)
npm run build        # static export: every route becomes HTML in out/
npm run check:build  # the checks on out/, src/ and vercel.json (run it after a build)
npm run verify       # every gate: typecheck, changed-file lint, unit, build, build check (E2E=1 adds the browser tests)
```

## The one setting

The site is built with exactly one variable, `NEXT_PUBLIC_API_URL`: the address (an origin) of the API it calls. Without it a build cannot reach anything and the build check fails. Nothing else is read at build time, and nothing secret may ever be put in a `NEXT_PUBLIC_` variable.

The browser tests (`E2E=1 LANE=<lane> JV_API_DIR=<checkout of jewelvault-api> npm run verify`) run against a throw-away API and database that the tests start themselves: see `tests/e2e/README.md`.

`next start` does not work with a static export. To look at the built site, serve the `out/` folder with any static server, for example `npx serve@latest out`.

## Rules

- Local commits only. The agent working in this repository never runs `git push` or `git pull`; the owner pushes and pulls by hand.
- No secrets in the repository or in the built site. `.env*` files are git-ignored.
- Production browser source maps stay off (`productionBrowserSourceMaps: false`); `out/` must contain no `.map` files.

## Folder map

- `src/` - the app (Next.js App Router): `app/` routes, `components/`, `lib/` (stores and helpers), `styles/`
- `public/` - static assets (logo, favicon)
- `scripts/` - the build check (`check-build.mjs`), the gates (`verify.mjs`), the pricing hash and the end-to-end lane
- `docs/handoffs.md` - what each finished task tells the next one
- `tests/` - `e2e/` for Playwright tests (config in `playwright.config.ts`); `unit/` for Vitest tests (config in `vitest.config.ts`); see `tests/README.md`

## Known gaps

- Vitest 4 and 5 could not be used: npm 10.9.8 crashes while resolving Vitest 4's peer packages, and Vitest 5 needs Node 22.12 or newer and `@types/node` 22. Vitest 3.2.7 is used instead. Revisit when the Node version is raised.
- `npm run lint` runs but reports many findings that came with the prototype (almost all Prettier formatting). Lint is not part of the build.
