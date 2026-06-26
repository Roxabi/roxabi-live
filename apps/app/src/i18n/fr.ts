/**
 * fr.ts — French catalog (source of truth). en.ts conforms to "typeof fr",
 * so adding a key here is a compile error until en.ts matches. Generated from
 * the extraction sweep, then hand-reviewed.
 */

export const fr = {
  header: {
    loading: "Chargement…",
    corpusStats: "{total} issues · {open} ouvertes · {closed} fermées",
    brandName: "Roxabi Live",
  },
  view: {
    graph: "Graphe",
    list: "Liste",
    table: "Tableau",
    groupAriaLabel: "Vue",
  },
  settings: {
    theme: {
      switchTo: "Passer au thème {next}",
      dark: "sombre",
      light: "clair",
    },
    title: "Paramètres",
    profile: {
      heading: "Profil",
      displayName: {
        label: "Nom affiché",
        hint: "Affiché dans l'en-tête. Login GitHub : {login}.",
      },
    },
    repos: {
      heading: "Dépôts",
      hint: "Ajoutez ou retirez les dépôts auxquels l'App GitHub accède.",
      empty: "Aucune installation liée pour l'instant.",
      configure: "Configurer les dépôts sur GitHub",
    },
    deleteAccount: {
      heading: "Supprimer le compte",
      hint: "Efface vos données Roxabi et vous déconnecte. Révoquez l'app sur GitHub séparément.",
      button: "Supprimer mes données & se déconnecter",
      confirmPrompt: "Supprimer toutes vos données Roxabi Live et vous déconnecter ? Action irréversible.",
      error: "Suppression impossible — réessayez.",
    },
    encryption: {
      heading: "Chiffrement",
    },
  },
  auth: {
    userMenu: {
      trigger: "Menu du compte",
      triggerTitle: "{name}",
      avatarAlt: "{login}",
      settings: "Paramètres",
      signOut: "Se déconnecter",
    },
    orgPicker: {
      ariaLabel: "Installation active",
    },
    signin: {
      title: "Se connecter",
      description: "Roxabi Live se connecte à votre compte GitHub pour piloter votre flotte d'agents.",
      githubButton: "Se connecter avec GitHub",
      rememberMe: "Rester connecté sur cet appareil",
    },
    signup: {
      title: "Créer votre compte",
      githubButton: "Continuer avec GitHub",
    },
    sessionLost: "Session expirée. Reconnectez-vous pour continuer.",
    consent: {
      title: "Accès aux données",
      description: "L'application est installée. Avant la première synchronisation, confirmez que Roxabi Live peut lire les métadonnées GitHub suivantes :",
      scope: {
        issues: "Issues, labels, milestones et relations parent/enfant",
        repoMeta: "Métadonnées des dépôts (nom, visibilité, archivage)",
        d1: "Données stockées dans Cloudflare D1, limitées à votre organisation",
      },
      loggedInAs: "Connecté en tant que {login}. Vous pouvez révoquer l'accès depuis vos {githubSettingsLink}.",
      githubSettingsLink: "paramètres GitHub",
      encryptionNotice: "Les titres et corps d'issues sont chiffrés côté client avant stockage. La structure du graphe (état, blockers, labels) reste lisible par l'opérateur.",
      error: "Enregistrement impossible — vérifiez votre connexion et réessayez.",
      confirmButton: "J'ai compris — lancer la synchronisation",
    },
    signout: "Se déconnecter",
    install: {
      title: "Installer Roxabi Live sur GitHub",
      description: "Connecté en tant que {login} (étape 1 terminée). Choisissez où installer l'application : compte personnel, organisation, ou dépôts sélectionnés uniquement.",
      option: {
        orgTitle: "Organisation",
        personalTitle: "Compte personnel",
        pickerName: "Choisir sur GitHub",
        pickerHint: "GitHub liste les organisations où vous pouvez installer l'app",
        personalHint: "Vos dépôts uniquement — idéal en solo",
        orgHint: "Installer sur cette org — tous les dépôts ou une sélection sur GitHub",
      },
      selectedRepos: {
        label: "Dépôts sélectionnés",
        hint: "Choisissez un compte ci-dessus, puis sur GitHub : Only select repositories et sélectionnez les dépôts à synchroniser.",
      },
      redirectHint: "GitHub vous demandera quels dépôts autoriser, puis vous ramènera ici. Si la redirection échoue, revenez et cliquez J'ai installé — continuer.",
      continueButton: "J'ai installé — continuer",
      notDetectedHint: "Installation pas encore détectée. Réessayez ou reconnectez-vous via GitHub ({fallbackUrl}).",
      sessionErrorHint: "Session expirée ou erreur réseau — rechargez la page ou reconnectez-vous.",
    },
    onboarding: {
      navAriaLabel: "Progression de l'installation",
      step: {
        github: "Connexion GitHub",
        install: "Installation",
        sync: "Synchronisation",
      },
    },
    loading: {
      srOnly: "Chargement de votre session…",
    },
    error: {
      loadSession: "Impossible de charger votre session : {message}",
    },
    signOut: "Se déconnecter",
  },
  sync: {
    halted: {
      title: "Synchronisation interrompue",
      detail: "{reposSynced} / {reposTotal} dépôts · Erreur d'authentification GitHub",
    },
    inProgress: {
      title: "Synchronisation de vos dépôts…",
      detail: "{reposSynced} / {reposTotal} dépôts · {issueCount} issues",
    },
  },
  dim: {
    label: {
      rows: "Lignes",
      cols: "Cols",
      group: "Groupe",
      orderBy: "Trier par",
      subgroup: "Sous-groupe",
    },
    option: {
      none: "Aucun",
      milestone: "Milestone",
      priority: "Priorité",
      repo: "Dépôt",
      lane: "Couloir",
      size: "Taille",
      status: "Statut",
      parent: "Parent",
      assignee: "Assigné",
    },
    empty: {
      milestone: "Aucun milestone",
      priority: "Aucune priorité",
      lane: "Aucun couloir",
      size: "Aucune taille",
      assignee: "Non assigné",
    },
  },
  graph: {
    toggle: {
      closed: {
        label: "Fermés",
        title: "Afficher les issues fermées dont l'epic parent est encore ouverte",
      },
      assignees: {
        label: "Assignés",
        title: "Afficher les logins des assignés sur les nœuds d'issue",
      },
    },
    empty: "Aucune issue ne correspond au filtre actuel.",
    edgesTitle: "Liens de dépendance",
    node: {
      title: "#{number} — {title}",
    },
  },
  toolbar: {
    filteredCount: "{count} sur {total}",
    display: "Affichage",
  },
  filter: {
    search: {
      placeholder: "Rechercher des issues…",
      ariaLabel: "Rechercher des issues",
    },
    facet: {
      status: "Statut",
      repo: "Dépôt",
      milestone: "Milestone",
      priority: "Priorité",
      label: "Label",
      assignee: "Assigné",
    },
    epics: {
      label: "Epics",
      title: "Afficher les epics (issues parentes)",
    },
    reset: {
      label: "Réinitialiser",
    },
    multiselect: {
      noOptions: "Aucune option",
      clear: "Effacer {label}",
    },
    empty: {
      milestone: "Aucun milestone",
      priority: "Aucune priorité",
      assignee: "Non assigné",
    },
  },
  table: {
    col: {
      status: "Statut",
      issue: "Issue",
      title: "Titre",
      milestone: "Milestone",
      priority: "Priorité",
      lane: "File",
      size: "Taille",
      blocks: "Bloque",
      blockedBy: "Bloqué par",
      parentOf: "Parent de",
    },
    empty: "Aucune issue à afficher.",
    row: {
      untitled: "sans titre",
      stubBadge: "ébauche",
      epicBadge: "epic",
    },
    card: {
      issueTitle: "Issue #{number}",
    },
  },
  pivot: {
    empty: "Aucune issue ne correspond au filtre actuel.",
  },
  status: {
    ready: "Prêt",
    blocked: "Bloqué",
    running: "En cours",
    done: "Terminé",
  },
  zk: {
    reset: {
      changePassphraseButton: "Changer la passphrase",
      currentPassphrase: {
        label: "Passphrase actuelle",
      },
      newPassphrase: {
        label: "Nouvelle passphrase",
      },
      confirmPassphrase: {
        label: "Confirmer la nouvelle passphrase",
      },
      cancel: "Annuler",
      saveButton: "Enregistrer la passphrase",
      warning: {
        title: "Réinitialiser le chiffrement ?",
        irreversibleBold: "Cette action est irréversible.",
        body: "Tous les titres d'issues chiffrés stockés pour votre compte sur le serveur seront supprimés. Vos titres précédemment chiffrés ne pourront plus être déchiffrés — ils sont définitivement perdus. Vous choisirez une nouvelle passphrase et re-scellerez le contenu depuis GitHub.",
        githubRequired: "Une connexion GitHub est requise pour confirmer cette action.",
        verifyGithub: "Vérifier avec GitHub",
      },
      execute: {
        title: "Confirmer la réinitialisation",
        description: "GitHub vérifié. Supprimer toutes vos données chiffrées et définir une nouvelle passphrase ?",
        confirmButton: "Réinitialiser et recommencer",
        errorReauthExpired: "Vérification expirée — réessayez.",
        errorRateLimited: "Trop de réinitialisations — réessayez plus tard.",
        errorGeneric: "Échec de la réinitialisation. Réessayez.",
      },
    },
    enroll: {
      title: "Définir la passphrase de chiffrement",
      description: "Choisissez une passphrase pour protéger votre clé de chiffrement. Elle ne quitte jamais ce navigateur ; seule une sauvegarde chiffrée est stockée sur le serveur. Cet appareil retient votre clé après la configuration — la passphrase sera requise sur d'autres appareils ou après un verrouillage.",
      passphrase: {
        label: "Passphrase",
      },
      confirmPassphrase: {
        label: "Confirmer la passphrase",
      },
      remember: {
        label: "Retenir la passphrase sur cet appareil pendant 30 jours",
      },
      submitButton: "Créer la sauvegarde",
      error: {
        tooShort: "La passphrase doit comporter au moins 8 caractères.",
        mismatch: "Les passphrases ne correspondent pas.",
        alreadyEnrolled: "Déjà enrôlé — déverrouillez plutôt avec votre passphrase.",
        generic: "Échec de l'enrôlement. Réessayez.",
      },
    },
    unlock: {
      title: "Déverrouiller le chiffrement",
      description: "Entrez votre passphrase de chiffrement pour déchiffrer les titres et corps d'issues sur cet appareil.",
      passphraseLabel: "Passphrase",
      rememberDevice: "Retenir la passphrase sur cet appareil pendant 30 jours",
      forgotPassword: "Mot de passe oublié ?",
      submit: "Déverrouiller",
      errorWrongPassphrase: "Passphrase incorrecte. Réessayez.",
    },
    common: {
      logout: "Se déconnecter",
      cancel: "Annuler",
    },
    device2: {
      title: "Terminez la configuration sur votre appareil d'origine",
      body1: "Des titres d'issues chiffrés sur ce compte ont été scellés dans un autre navigateur avant la configuration de la sauvegarde par passphrase. Cet appareil ne peut pas les déchiffrer ni terminer l'enrôlement tant que vous n'ouvrez pas Roxabi sur votre appareil d'origine pour y finaliser le chiffrement.",
      body2Prefix: "Une fois la configuration faite sur l'appareil d'origine, vous pouvez aussi",
      linkGithub: "lier GitHub",
      body2Suffix: "ici pour re-sceller le contenu depuis GitHub.",
      reload: "Recharger",
    },
    notice: {
      info: {
        body: "Les titres et le contenu de vos issues sont chiffrés et ne sont jamais accessibles en clair sur le serveur. Votre passphrase n'est pas récupérable : en cas de perte, vous devrez en générer une nouvelle.",
        dismiss: "Fermer",
      },
      githubLink: {
        body: "Certains titres restent chiffrés sur le serveur. Liez GitHub pour importer et re-sceller leur contenu.",
        cta: "Lier GitHub",
      },
      migration: {
        body: "Migration du chiffrement incomplète — certains anciens titres n'ont pas pu être convertis. Ouvrez Roxabi sur l'appareil d'origine pour la terminer.",
      },
    },
    lock: {
      title: "Verrouiller le chiffrement (effacer la clé de la mémoire)",
      label: "Verrouiller",
    },
    gate: {
      loadingSrOnly: "Déverrouillage du chiffrement…",
    },
  },
};

export type Translations = typeof fr;
