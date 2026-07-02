# Product positioning — landing page rationale

Status: **shipped** — [PR #271](https://github.com/Roxabi/roxabi-live/pull/271) (`apps/marketing`).

## Old positioning (dead)

Roxabi Live used to be pitched as a "GitHub dependency-graph viewer" — the third
rebuild of essentially the same graph/table/list view. That framing is dead: it
describes a feature, not a job-to-be-done, and doesn't survive contact with a
fleet of concurrent coding agents.

## New positioning

> **Le poste de pilotage de votre flotte d'agents** — the control deck for
> running a fleet of AI coding agents *without collisions*.

Core message: once you run a fleet of agents, the bottleneck is no longer
writing code — it's **development concurrency**. A per-issue kanban lifecycle
is obsolete (an agent can cross an issue in minutes); what matters is *which
issues can run in parallel without conflict*, on one project or across many.

Method: conflicts are declared as GitHub-native `blocked-by` relations via
`/issue-triage` (no second DB or tracker). The board then computes
ready / blocked / running / done at a glance, straight from the issue graph.

## Signature component — Launch Board

"Le plan de bataille": project columns × issue cards using the 4-status
vocabulary (ready / blocked / running / done). Several emerald `ready` cards
lit up across columns is the "lance ces N en parallèle" moment — the whole
point of the redesign.

Shipped as `apps/marketing/src/components/LaunchBoard.astro`; French copy
(default locale) lives in `apps/marketing/src/i18n/fr.ts` (`eyebrowLeft:
"Pilotage de flotte"`, hero lead on concurrency, CTA "Prêt à piloter votre
flotte sans collision ?").

## Why this is durable

This is a product-strategy decision, not something derivable from the shipped
Astro code alone — it came from the user's own pitch, not from git history.
Any future rework of the marketing site's hero/framing should preserve the
fleet-concurrency angle and the Launch Board centerpiece; do not regress to
"dependency-graph viewer" / "3 views" framing.

## How it was built

Diverge → judge → synthesize workflow across positioning concepts; the winner
was "concept-b" (Launch Board as centerpiece). Status colors are intentionally
distinct from the Roxabi brand amber — see the design tokens referenced by the
Claude Design build that produced this concept.
