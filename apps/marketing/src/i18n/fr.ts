export const fr = {
  // ── Meta ──────────────────────────────────────────────────────────────────
  siteTitle: "Roxabi Live — Le poste de pilotage de votre flotte d'agents",
  siteDescription:
    "Lancez dix agents à la fois, sans qu'ils se marchent dessus. Roxabi Live lit vos issues GitHub et leurs liens blocked-by pour révéler ce que vous pouvez lancer en parallèle.",

  // ── Header ────────────────────────────────────────────────────────────────
  header: {
    navComment:   "Commentaires",
    navAdmin:     "Admin",
    loginLabel:   "Connexion",
    ctaLabel:     "Accès anticipé",
  },

  // ── Hero ──────────────────────────────────────────────────────────────────
  hero: {
    eyebrowLeft:  "Pilotage de flotte",
    eyebrowRight: "GitHub natif",
    h1Part1:      "Lancez dix agents à la fois.",
    h1Accent:     "Sans qu'ils se marchent dessus.",
    lead:         "Le goulot d'étranglement d'une flotte d'agents, ce n'est plus l'écriture du code — c'est la concurrence. Roxabi Live lit vos issues GitHub et leurs liens blocked-by pour révéler, d'un coup d'œil, ce que vous pouvez lancer en parallèle.",
    ctaPrimary:   "Demander l'accès anticipé",
    ctaGhost:     "Voir la démo",
    note:         "GitHub Issues natif · aucun outil tiers · zéro friction d'adoption",
    boardTitle:   "roxabi-live · tableau de bord",
    boardLive:    "live",
    legendReady:   "ready",
    legendRunning: "running",
    legendBlocked: "blocked",
    legendDone:    "done",
    launchCount:   "4 prêts à lancer",
    ticker:        "sync · il y a 2 min",
  },

  // ── Problem ───────────────────────────────────────────────────────────────
  problem: {
    kicker:  "Le problème",
    h2:      "Les flottes d'agents s'effondrent sans orchestration.",
    lead:    "Les outils d'IA génèrent du code à vitesse industrielle. Le vrai défi, c'est de coordonner des dizaines d'agents sans qu'ils se bloquent mutuellement.",
    pains: [
      {
        num: "01",
        h3:  "Conflits de branche invisibles",
        p:   "Deux agents modifient les mêmes fichiers. Résultat : conflits de merge, temps perdu, régressions silencieuses.",
      },
      {
        num: "02",
        h3:  "Dépendances ignorées",
        p:   "Un agent démarre une tâche dont le prérequis n'est pas terminé. Il fonce dans le mur, ou pire, livre quelque chose de cassé.",
      },
      {
        num: "03",
        h3:  "Visibilité zéro sur la flotte",
        p:   "Qui tourne ? Qui attend ? Qui est bloqué ? Sans tableau de bord unifié, piloter 10 agents en parallèle revient à voler à l'aveugle.",
      },
    ],
  },

  // ── Method ────────────────────────────────────────────────────────────────
  method: {
    kicker:  "La méthode",
    h2:      "GitHub Issues comme système nerveux de votre flotte.",
    lead:    "Pas d'outil supplémentaire. Roxabi Live s'appuie sur ce que vous faites déjà — issues, labels, dépendances — pour calculer en temps réel ce qui peut avancer.",
    steps: [
      {
        num:   "Étape 01",
        cmd:   "/issue-triage",
        h3:    "Triez avec des labels sémantiques",
        pPre:  "Utilisez ",
        pMid:  " pour labelliser automatiquement chaque issue : taille, priorité, type. Liez les dépendances avec ",
        pPost: ". Tout reste dans GitHub.",
      },
      {
        num:  "Étape 02",
        cmd:  "sync · webhooks",
        h3:   "Synchronisation temps réel",
        p:    "Roxabi Live écoute vos webhooks GitHub et réconcilie le graphe de dépendances en continu. Chaque changement d'état se propage instantanément.",
        pillsLabel: "statuts calculés :",
      },
      {
        num:  "Étape 03",
        cmd:  "launch · parallel",
        h3:   "Lancez en parallèle, sans risque",
        p:    "Le tableau de bord révèle en un coup d'œil quelles issues sont prêtes. Aucune dépendance ouverte = feu vert pour l'agent. Tous les autres restent en attente.",
      },
    ],
  },

  // ── Paradigm ──────────────────────────────────────────────────────────────
  paradigm: {
    kicker:    "Le changement de paradigme",
    headline:  "Ce n'est plus vous qui orchestrez — c'est le graphe.",
    body:      "Jusqu'ici, coordonner des agents demandait une attention manuelle permanente : qui peut commencer ? qui attend quoi ? Roxabi Live automatise cette décision à partir de vos issues et de leurs dépendances GitHub natives.",
    oldLabel:  "Avant",
    oldText:   "Coordination manuelle, tableurs, Slack, risque d'oubli permanent",
    arrow:     "→",
    newLabel:  "Maintenant",
    newText:   "Graphe de dépendances auto-calculé, statuts temps réel, lancement sans risque",
    close:     "Vous continuez à travailler dans GitHub. Le graphe fait le reste.",
  },

  // ── GitHub Native ─────────────────────────────────────────────────────────
  github: {
    kicker: "GitHub natif, zéro friction",
    h2:     "Votre source de vérité reste GitHub.",
    p1:     "Roxabi Live ne remplace pas votre workflow — il l'augmente. Issues, labels, sub-issues, blocked-by : tout reste dans GitHub, là où vos agents lisent et écrivent déjà.",
    p2:     "Pas de migration. Pas de double saisie. Pas d'outil tiers à apprendre.",
    trust: [
      {
        iconType: "shield",
        strong: "Aucune donnée hors GitHub",
        span:   "Roxabi Live lit vos issues via l'API GraphQL officielle. Rien n'est répliqué dans un silo externe.",
      },
      {
        iconType: "bolt",
        strong: "Sync temps réel par webhook",
        span:   "Chaque push, PR, ou changement d'issue déclenche une mise à jour instantanée du graphe.",
      },
      {
        iconType: "lock",
        strong: "Accès restreint à votre org",
        span:   "Installation GitHub App scoped à votre organisation. Permissions minimales, audit log natif.",
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
        detail: "issue sensible → [redacted] dans le board",
      },
    ],
  },

  // ── CTA Band ──────────────────────────────────────────────────────────────
  cta: {
    kicker:      "Accès anticipé",
    h2Part1:     "Prêt à piloter votre flotte",
    h2Accent:    "sans collision ?",
    body:        "Rejoignez les équipes qui orchestrent leurs agents Claude avec des graphes de dépendances GitHub, en temps réel.",
    ctaPrimary:  "Demander l'accès anticipé",
    ctaGhost:    "Voir la démo",
    reassurance: "Accès sur invitation · GitHub Issues natif · aucune carte requise",
  },

  // ── Footer ────────────────────────────────────────────────────────────────
  footer: {
    logoWordmark: "Live",
    links: [
      { label: "Commentaires", href: "/feedback" },
      { label: "Admin",        href: "/admin"    },
      { label: "GitHub",       href: "https://github.com/Roxabi" },
    ],
    copy: "© 2026 Roxabi",
  },

  // ── Lang switcher ─────────────────────────────────────────────────────────
  langSwitchLabel: "EN",
  langSwitchHref:  "/en/",
} as const;

export type Translations = typeof fr;
