# Roxabi Live — Monorepo migration (modeled on roxabi-links / enishu)

Status: **Phase 1 done** (architecture/stack scaffold). Design implementation + the
app/api split = **step 2**. Target model = enishu (`roxabi-links`): bun workspaces,
marketing split out as its own deploy, a shared brand SSOT consumed by every surface.

## Current production setup (unchanged by Phase 1)

A single Cloudflare Worker does everything:

| Piece | What | Touched in Phase 1? |
|---|---|---|
| `worker/` (Hono) | API + webhook + sync + serves the frontend via ASSETS | **No** — npm island, deploy untouched |
| `frontend/` (vanilla HTML/CSS/JS) | landing + auth + zk + dashboard, served by the Worker | **No** |
| `wrangler.toml` (root) | `main=worker/src/index.ts`, ASSETS=`./frontend`, D1 `DB`, R2 `LOGS`, route `live.roxabi.dev` | **No** |
| `infra/workers-builds.json` | CF Workers Builds: `cd worker && npm ci` → `deploy-{prod,staging}.sh`, branches main/staging | **No** |
| CI (`.github/workflows/ci.yml`) | per-subdir: tools=uv, `worker`=npm, `plugins/roxabi-issues`=bun, `frontend`=npm | **No** |

→ prod deploy + CI stay green on this branch. The new tree is purely additive.

## Phase 1 — what landed (this branch)

```
package.json            bun workspaces ["apps/*","packages/*"], packageManager bun@1.3.14
bun.lock                (root npm package-lock.json removed)
brand/                  SHARED DESIGN-SYSTEM SSOT — synced from Claude Design
  styles.css              entry (consumers @import this only)
  base.css                reset + amber-bloom canvas + utilities + graph keyframes
  tokens/                 colors · typography · spacing · elevation · motion · fonts
  assets/                 logo-mark · logo-glyph · wordmark (SVG)
  BRAND-BOOK.md           the canonical brand doc
packages/shared/        @roxabi-live/shared — TS contract (Phase 1: brand.ts token mirror)
apps/marketing/         @roxabi-live/marketing — Astro SSG, consumes brand via
                        @import "../../../../brand/styles.css"; → CF Pages target
```

Verified: `bun install` clean · `bun run build:marketing` → `dist/` with brand tokens
bundled · `bun --filter @roxabi-live/shared typecheck` green · placeholder rendered in a
real browser (deep-slate bg + amber bloom + Inter-900 headline).

`apps/marketing/src/pages/index.astro` is a **placeholder smoke test**, not the final
landing — the real landing (Claude Design `concept-b`) is ported in step 2.

## Brand sharing (the enishu two-layer pattern)

- **CSS layer** → `brand/` (root dir, not a package). Marketing + the future app `@import`
  `brand/styles.css` by relative path. SSOT for token *values*.
- **TS layer** → `packages/shared/src/brand.ts` mirrors the hexes for code that can't read
  CSS vars (graph rendering, email, OG). Keep in sync on re-sync from Claude Design.

## Step 2 — open decisions + the "important changes"

These are the bigger, coupled changes (mostly **deploy/infra + the app rewrite**), deferred:

1. **Domain topology** *(blocks the app/api split)* — enishu = apex(marketing) + `app.` + `api.`
   subdomains. To split, marketing → apex `live.roxabi.dev` (Pages) and the app/api Worker →
   `app.live.roxabi.dev`. That changes the app URL + **CF Access** config (#150 cutover) +
   **session cookie domain** + **zk** origin. Decide before splitting.
2. **worker/ → apps/api/** rename + bun-unify → requires updating `infra/workers-builds.json`
   (rootDirectory/build command) **and the CF Workers Builds dashboard** (otherwise auto-deploy
   breaks). Coordinate; do NOT push the rename until CF is reconfigured.
3. **apps/app/ (React SPA)** — migrate the vanilla `frontend/` dashboard to the enishu app stack:
   **React 19 + Vite + TanStack Router/Query + Tailwind v4 + shadcn/ui (Radix + cva + tailwind-merge)
   + Phosphor icons**, deployed as a Worker serving its dist + proxying `/api*` via service binding.
   Big rewrite (graph/list/pivot/zk/auth) — this is where the Claude Design React components pay off.
4. **Port the landing** into `apps/marketing` as real `.astro` components (SiteHeader, Hero +
   LaunchBoard, Problem, Method, GitHub-native, CTA) + i18n (FR **and EN**).
5. **CI** — add `apps/marketing` (+ later `apps/app`, `packages/shared`) jobs; add a marketing
   Pages project in CF.
6. **Re-sync brand** from Claude Design once the graph/cockpit design is finalised there.
