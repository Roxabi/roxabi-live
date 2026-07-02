import type { Translations } from "./fr";

export const en: Translations = {
  // ── Meta ──────────────────────────────────────────────────────────────────
  siteTitle: "Roxabi Live — Command center for your agent fleet",
  siteDescription:
    "Launch ten agents at once without collisions. Roxabi Live reads your GitHub issues and their blocked-by links to reveal what you can run in parallel.",

  // ── Header ────────────────────────────────────────────────────────────────
  header: {
    navComment:   "Feedback",
    navAdmin:     "Admin",
    navCommentHref: "https://github.com/Roxabi/roxabi-live/issues/new/choose",
    loginLabel:   "Sign in",
  },

  // ── Hero ──────────────────────────────────────────────────────────────────
  hero: {
    eyebrowLeft:  "Fleet command",
    eyebrowRight: "GitHub native",
    h1Part1:      "Launch ten agents at once.",
    h1Accent:     "Without collisions.",
    lead:         "The bottleneck for an agent fleet is no longer writing code — it's concurrency. Roxabi Live reads your GitHub issues and their blocked-by links to reveal, at a glance, what you can run in parallel.",
    ctaPrimary:   "Sign in",
    ctaGhost:     "View demo",
    note:         "Native GitHub Issues · no third-party tools · zero adoption friction",
    boardTitle:   "roxabi-live · dashboard",
    boardLive:    "live",
    legendReady:   "ready",
    legendRunning: "running",
    legendBlocked: "blocked",
    legendDone:    "done",
    launchCount:   "4 ready to launch",
    ticker:        "sync · 2 min ago",
  },

  // ── Problem ───────────────────────────────────────────────────────────────
  problem: {
    kicker: "The problem",
    h2:     "Agent fleets collapse without orchestration.",
    lead:   "AI tools generate code at industrial speed. The real challenge is coordinating dozens of agents without them blocking each other.",
    pains: [
      {
        num: "01",
        h3:  "Invisible branch conflicts",
        p:   "Two agents modify the same files. Result: merge conflicts, wasted time, silent regressions.",
      },
      {
        num: "02",
        h3:  "Ignored dependencies",
        p:   "An agent starts a task whose prerequisite isn't finished yet. It hits a wall, or worse, ships something broken.",
      },
      {
        num: "03",
        h3:  "Zero fleet visibility",
        p:   "Who's running? Who's waiting? Who's blocked? Without a unified dashboard, running 10 agents in parallel is flying blind.",
      },
    ],
  },

  // ── Method ────────────────────────────────────────────────────────────────
  method: {
    kicker: "The method",
    h2:     "GitHub Issues as the nervous system of your fleet.",
    lead:   "No extra tooling. Roxabi Live builds on what you already do — issues, labels, dependencies — to compute in real time what can move forward.",
    steps: [
      {
        num:   "Step 01",
        cmd:   "/issue-triage",
        h3:    "Triage with semantic labels",
        pPre:  "Use ",
        pMid:  " to automatically label each issue: size, priority, type. Link dependencies with ",
        pPost: ". Everything stays in GitHub.",
      },
      {
        num:  "Step 02",
        cmd:  "sync · webhooks",
        h3:   "Real-time synchronization",
        p:    "Roxabi Live listens to your GitHub webhooks and continuously reconciles the dependency graph. Every state change propagates instantly.",
        pillsLabel: "computed statuses:",
      },
      {
        num:  "Step 03",
        cmd:  "launch · parallel",
        h3:   "Launch in parallel, safely",
        p:    "The dashboard reveals at a glance which issues are ready. No open dependency = green light for the agent. All others stay on hold.",
      },
    ],
  },

  // ── Paradigm ──────────────────────────────────────────────────────────────
  paradigm: {
    kicker:    "The paradigm shift",
    headline:  "You no longer orchestrate — the graph does.",
    body:      "Until now, coordinating agents required constant manual attention: who can start? who is waiting for what? Roxabi Live automates this decision from your issues and their native GitHub dependencies.",
    oldLabel:  "Before",
    oldText:   "Manual coordination, spreadsheets, Slack, permanent risk of oversight",
    arrow:     "→",
    newLabel:  "Now",
    newText:   "Auto-computed dependency graph, real-time statuses, collision-free launches",
    close:     "You keep working in GitHub. The graph does the rest.",
  },

  // ── GitHub Native ─────────────────────────────────────────────────────────
  github: {
    kicker: "GitHub native, zero friction",
    h2:     "Your source of truth stays GitHub.",
    p1:     "Roxabi Live doesn't replace your workflow — it augments it. Issues, labels, sub-issues, blocked-by: everything stays in GitHub, where your agents already read and write.",
    p2:     "No migration. No double entry. No third-party tool to learn.",
    trust: [
      {
        iconType: "shield",
        strong: "No data outside GitHub",
        span:   "Roxabi Live reads your issues via the official GraphQL API. Nothing is replicated to an external silo.",
      },
      {
        iconType: "bolt",
        strong: "Real-time sync via webhook",
        span:   "Every push, PR, or issue change triggers an instant graph update.",
      },
      {
        iconType: "lock",
        strong: "Scoped to your org",
        span:   "GitHub App installation scoped to your organization. Minimal permissions, native audit log.",
      },
    ],
    events: [
      {
        iconClass: "webhook",
        iconLabel:  "W",
        type:   "WEBHOOK",
        desc:   "issues.closed",
        detail: "#839 Refactor clipool worker → done",
      },
      {
        iconClass: "graphql",
        iconLabel:  "G",
        type:   "GRAPHQL",
        desc:   "blockedBy resolved",
        detail: "#855 Migrate vers bun workspace → ready",
      },
      {
        iconClass: "zk",
        iconLabel:  "ZK",
        type:   "ZK",
        desc:   "title redacted",
        detail: "sensitive issue → [redacted] in board",
      },
    ],
  },

  // ── CTA Band ──────────────────────────────────────────────────────────────
  cta: {
    kicker:      "Get started",
    h2Part1:     "Ready to run your fleet",
    h2Accent:    "without collisions?",
    body:        "Join the teams orchestrating their Claude agents with GitHub dependency graphs, in real time.",
    ctaPrimary:  "Sign in",
    ctaGhost:    "View demo",
    reassurance: "Native GitHub Issues · no card required · zero adoption friction",
  },

  // ── Footer ────────────────────────────────────────────────────────────────
  footer: {
    logoWordmark: "Live",
    links: [
      { label: "Agent guide", href: "/en/for-agents" },
      { label: "llms.txt",    href: "/llms.txt" },
      { label: "Feedback",    href: "https://github.com/Roxabi/roxabi-live/issues/new/choose" },
      { label: "Admin",       href: "https://app.live.roxabi.dev/admin", appPath: "/admin" },
      { label: "GitHub",      href: "https://github.com/Roxabi/roxabi-live" },
    ],
    copy: "© 2026 Roxabi",
  },

  // ── Lang switcher ─────────────────────────────────────────────────────────
  langSwitchLabel: "FR",
  langSwitchHref:  "/",
} as const;
