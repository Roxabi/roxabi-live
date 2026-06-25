<!-- SYNCED from Claude Design project "Design System" (id 1ab6b424-…2615) via /design-sync.
     This is the canonical brand doc. The CSS layer (styles.css, base.css, tokens/, assets/)
     is vendored here as the shared SSoT. The React component primitives, foundation cards,
     cockpit UI kit and landing live in Claude Design and are pulled at design-impl (step 2).
     Do not hand-edit tokens to diverge from Claude Design — re-sync instead. -->

# Roxabi Live — Design System

> Le poste de pilotage de votre flotte d'agents.
> The design system for Roxabi Live: a dark, amber-accented operator console for piloting fleets of coding agents across GitHub.

---

## 1 · Product context

**Roxabi Live** is a GitHub-native control surface for teams running *fleets of coding agents*. Its thesis: when ten agents can write code in parallel, the bottleneck is no longer writing code — it's **concurrency**. Two agents touching the same files collide; a step-based Kanban can't keep up with issues that close in minutes.

Roxabi Live reads your GitHub issues and their native relations (`blocked-by`, parent/child sub-issues) and **continuously computes what can run right now, without conflict**, across every repo at once. Its flagship surface is the **dependency graph** — issues as animated nodes (running / PR-open / PR-merging / blocked / done), grouped into labelled capsules, organised by milestone — backed by a four-word status vocabulary:

- **ready** — launchable now (no open blocker)
- **blocked** — waiting on a prerequisite
- **running** — an agent is live on it
- **done** — issue closed

The product is **GitHub-native** (no second database), updates via **webhooks in real time**, reconciles nightly via the **GitHub GraphQL API**, runs on **Cloudflare Workers + D1**, and keeps issue titles/bodies **zero-knowledge encrypted client-side**. The triage workflow is driven by a `/issue-triage` Claude Code command that sets `blocked-by` links and labels.

Primary language is **French** (vouvoiement). The brand voice is a cockpit/fleet metaphor — terse, confident, imperative.

### Products / surfaces represented
- **Marketing landing** (`apps/marketing/`) — the public site that sells the concurrency thesis.
- **Cockpit** — the operator app: connect → board / list / dependency-graph → launch agents.
- **Concept explorations** — three earlier landing directions kept for reference in Claude Design.

---

## 2 · Content fundamentals

**Language.** French, formal **vous**. Sentences are short and declarative; one idea per sentence. Headlines use the imperative ("Lancez dix agents", "Branchez mes dépôts", "Lisez la concurrence").

**Tone.** Cockpit / aviation / fleet command. Recurring nouns: *flotte, poste de pilotage, plan de bataille, concurrence, ordres*. The product is framed as **a method, not another tool** ("Une méthode, pas un outil de plus").

**Casing.** Sentence case for prose. Eyebrows/kickers and status pills are the exception:
- Eyebrows: **UPPERCASE**, mono, wide-tracked ("LE PROBLÈME", "GITHUB NATIF").
- Status & commands: **lowercase**, mono (`ready`, `running`, `/issue-triage`, `#847`).

**I vs you.** Always address the operator as *vous*; the product speaks about itself in third person ("Roxabi Live calcule…"), never "we/nous" in UI copy.

**Numbers & refs.** Issue refs (`#847`), repo names (`roxabi-factory`), counts ("4 ready — lancez maintenant") are always set in mono. Don't invent vanity metrics — counts are real tallies the board computes.

**Emoji.** None. The only glyph used decoratively is **⛒** (blocked marker) in front of "bloquée par #839".

**Examples.**
- Hero: *"Lancez dix agents à la fois. Sans qu'ils se marchent dessus."*
- Lead: *"Le goulot d'étranglement d'une flotte d'agents, ce n'est plus l'écriture du code — c'est la concurrence."*
- Paradigm: *"Le pilotage par étapes est mort. Vive le pilotage par concurrence."*
- CTA reassurance: *"GitHub App · Lecture seule · Sans carte bancaire"*

---

## 3 · Visual foundations

**Mood.** A near-black **cockpit at night**: deep canvas, warm-ivory ink, a single amber instrument glow, and four status colors that behave like indicator lights.

**Color.**
- Canvas `--bg #0b0e14` → panels `--bg-elevated #11161f` → cards `--bg-card #151b25` → hover `#1a2230`. Elevation is communicated by getting *lighter*, plus shadow.
- Ink is warm ivory `--text #f2efe9`, not pure white — softens the dark UI. Two dimmer steps (`--text-muted`, `--text-dim`) for hierarchy.
- **One** brand accent: **amber `--accent #f0b429`** (CTAs, links, focus, logo, eyebrows). Hover lightens (`#f5c542`), press darkens (`#d99c10`). Amber is *never* used for status.
- **Status palette is sacred and separate:** ready = emerald `#34d399`, blocked = rose `#fb7185`, running = sky `#38bdf8`, done = slate `#5b6473`. Each has a ~14% tint companion for fills.

**Type.** Two families only.
- **Inter** for everything human: display at **900** weight, tracked tight (`-0.04em`); body at 400–600, line-height 1.65; warm ivory.
- **JetBrains Mono** for the machine voice: status pills, issue refs, commands, eyebrows, tickers, metadata. Wide tracking (0.06–0.12em). Pills lowercase, eyebrows uppercase.

**Spacing.** 4px base, dense **instrument-panel** rhythm. Cards pad 8–12px; sections breathe at 80–100px. Layout maxes at 1120px.

**Backgrounds.** No photography, no illustration. The signature device is a single **amber radial bloom** at the top of the page (`radial-gradient(ellipse 70% 45% at 50% -8%, --accent-glow, transparent)`), as if the instrument panel glows. Panels add a faint amber under-glow (`--glow-amber`). Surfaces are flat solids — no busy gradients, no texture, no noise.

**Borders.** Hairline `--border #222b38`, brightening to `--border-hi #313d4e` on hover/emphasis. 1px everywhere; 1.5px on buttons.

**Corner radii.** Modest, this is a control surface: 6px on controls/pills/inputs, 10px on cards/columns, 14px on feature cards, 20px on big panels (boards, hero, CTA).

**Cards.** Solid `--bg-card`, 1px `--border`, `--shadow-card` (a faint dark halo, not grey). On hover: lighten to `--bg-card-hover` + border to `--border-hi`. **No colored left-border accents** — status is communicated by the badge, glow, and bottom bar instead.

**Shadows.** Deep and soft because the canvas is near-black: `--shadow-panel: 0 18px 50px -12px rgba(0,0,0,.7)`. Big product panels layer the amber under-glow on top.

**Elevation & glow.** `ready` cards carry a faint emerald breathing glow; `running` cards a sky pulse + a 2px bottom progress bar; the board's "live" dot pulses emerald.

**Animation.** Restrained and mechanical. Entrances/hovers use a confident ease-out `cubic-bezier(.16,1,.3,1)`; ambient "alive" loops (ready glow, running pulse, live dot, ticker blink) use a symmetric ease-in-out. Durations: 120ms (press), 220ms (hover/color), 420ms (entrance). **Nothing bounces.** All looping motion is gated behind `prefers-reduced-motion`.

**Hover states.** Buttons lift 1px + gain a soft amber shadow (primary) or shift outline→amber (ghost). Cards lighten background + brighten border. Nav items get a 4% white wash.

**Press states.** Primary button darkens to `--accent-press` and drops the lift (no shrink). Snappy 120ms.

**Transparency & blur.** Sparingly: the fixed site header is `rgba(11,14,20,.88)` + `backdrop-filter: blur(12px)`. Board chrome uses translucent `rgba(11,14,20,.6)` over the panel. No glassmorphism beyond these.

---

## 4 · Iconography

- **Style:** thin-stroke line icons, ~1.3px stroke, drawn inline as small SVGs. They inherit `currentColor` and are tinted with status or accent colors.
- **Recommended set for new work:** Phosphor (`@phosphor-icons/react`, matching the planned React app stack) or Lucide — both with thin strokes that match the existing hand-drawn SVGs. Tint with tokens.
- **Glyphs as icons:** **⛒** marks a blocked issue's blocker. Chrome "traffic-light" dots reuse rose/amber/emerald.
- **Emoji:** never.
- **Logo:** the brand mark is four offset rounded squares at 90 / 60 / 60 / 30% opacity on an amber tile — a small *concurrency grid*. See `assets/`. Never recolor the mark; the amber tile is fixed.

---

## 5 · File index (this folder = `brand/`)

- `styles.css` — global entry point. Consumers link **this file only**. Pure `@import` list.
- `base.css` — reset, element defaults, amber-bloom canvas, utility classes (`.container`, `.eyebrow`, `.lead`, `.mono`) + graph keyframes.
- `tokens/` — CSS custom properties: `fonts.css` · `colors.css` · `typography.css` · `spacing.css` · `elevation.css` · `motion.css`.
- `assets/` — brand marks: `logo-mark.svg` (amber tile + glyph) · `logo-glyph.svg` (glyph only) · `wordmark.svg` (lockup).
- `BRAND-BOOK.md` — this guide.

**TS mirror:** `packages/shared/src/brand.ts` exposes the token hexes as TS constants for runtime/build-time consumers (graph rendering, email, OG images).

---

## 6 · Using the system (in this monorepo)

- **Plain HTML / Astro (`apps/marketing`):** `@import` `brand/styles.css` (relative path), use the token variables + utility classes. Add `class="bloom-canvas"` to `<body>` for the amber glow.
- **React (`apps/app`, planned):** import `brand/styles.css` once, then consume CSS variables in Tailwind/shadcn theme + `@roxabi-live/shared` token constants where TS values are needed.
- **Sacred rules:** one amber action per view · status colors never reused for brand · mono for machine voice · no emoji · no colored left-border accents · French vouvoiement.
