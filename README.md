# JewelVault

Jewellery inventory, barcode and billing software for Jaishri Gold Palace Pvt Ltd. It is a static Next.js 16 site (React 19, Tailwind CSS 3) built from the original prototype. Today all data lives in the browser (localStorage); a Supabase database comes in later phases.

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
```

`next start` does not work with a static export. To look at the built site, serve the `out/` folder with any static server, for example `npx serve@latest out`.

## Rules

- Local commits only. The agent working in this repository never runs `git push` or `git pull`; the owner pushes and pulls by hand.
- No secrets in the repository or in the built site. `.env*` files are git-ignored.
- Production browser source maps stay off (`productionBrowserSourceMaps: false`); `out/` must contain no `.map` files.

## Folder map

- `src/` - the app (Next.js App Router): `app/` routes, `components/`, `lib/` (stores and helpers), `styles/`
- `public/` - static assets (logo, favicon)
- `supabase/` - `migrations/` and `tests/` for the database; the CLI runs with `npx supabase`. Nothing is started or linked yet.
- `specs/` - written specs, one folder per phase (`specs/p1-foundation-and-money/`)
- `tests/` - `e2e/` for Playwright tests (config in `playwright.config.ts`); `unit/` for Vitest tests (config in `vitest.config.ts`)

## Known gaps

- Vitest 4 and 5 could not be used: npm 10.9.8 crashes while resolving Vitest 4's peer packages, and Vitest 5 needs Node 22.12 or newer and `@types/node` 22. Vitest 3.2.7 is used instead. Revisit when the Node version is raised.
- The prototype still has demo logins hard-coded in `src/lib/authStore.ts` and `src/components/LoginScreen.tsx`, so they are visible in the built JavaScript. They are removed in a later phase.
- `npm run lint` runs but reports many findings that came with the prototype (almost all Prettier formatting). Lint is not part of the build.
