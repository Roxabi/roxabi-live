/**
 * en.ts — English catalog. Structurally typed against the French source so the
 * two stay in lockstep (missing/extra keys fail typecheck).
 */

import type { Translations } from "./fr";

export const en: Translations = {
  header: {
    loading: "Loading…",
    corpusStats: "{total} issues · {open} open · {closed} closed",
    brandName: "Roxabi Live",
  },
  view: {
    graph: "Graph",
    list: "List",
    table: "Table",
    groupAriaLabel: "View",
  },
  settings: {
    theme: {
      switchTo: "Switch to {next} theme",
      dark: "dark",
      light: "light",
    },
    title: "Settings",
    profile: {
      heading: "Profile",
      displayName: {
        label: "Display name",
        hint: "Shown in the header. GitHub login: {login}.",
      },
    },
    repos: {
      heading: "Repositories",
      hint: "Add or remove repositories that the GitHub App can access.",
      empty: "No linked installation yet.",
      configure: "Configure repositories on GitHub",
    },
    deleteAccount: {
      heading: "Delete account",
      hint: "Erases your Roxabi data and logs you out. Revoke the app on GitHub separately.",
      button: "Delete my data & sign out",
      confirmPrompt: "Delete all your Roxabi Live data and sign out? This action is irreversible.",
      error: "Deletion failed — please try again.",
    },
    encryption: {
      heading: "Encryption",
    },
  },
  auth: {
    userMenu: {
      trigger: "Account menu",
      triggerTitle: "{name}",
      avatarAlt: "{login}",
      settings: "Settings",
      signOut: "Sign out",
    },
    orgPicker: {
      ariaLabel: "Active installation",
    },
    signin: {
      title: "Sign in",
      description: "Roxabi Live connects to your GitHub account to manage your fleet of agents.",
      githubButton: "Sign in with GitHub",
      rememberMe: "Stay signed in on this device",
    },
    signup: {
      title: "Create your account",
      githubButton: "Continue with GitHub",
    },
    sessionLost: "Session expired. Please sign in again to continue.",
    consent: {
      title: "Data access",
      description: "The application is installed. Before the first sync, confirm that Roxabi Live may read the following GitHub metadata:",
      scope: {
        issues: "Issues, labels, milestones and parent/child relations",
        repoMeta: "Repository metadata (name, visibility, archiving)",
        d1: "Data stored in Cloudflare D1, limited to your organisation",
      },
      loggedInAs: "Signed in as {login}. You can revoke access from your {githubSettingsLink}.",
      githubSettingsLink: "GitHub settings",
      encryptionNotice: "Issue titles and bodies are encrypted client-side before storage. The graph structure (status, blockers, labels) remains readable by the operator.",
      error: "Could not save — check your connection and try again.",
      confirmButton: "Understood — start sync",
    },
    signout: "Sign out",
    install: {
      title: "Install Roxabi Live on GitHub",
      description: "Signed in as {login} (step 1 done). Choose where to install the application: personal account, organisation, or selected repositories only.",
      option: {
        orgTitle: "Organisation",
        personalTitle: "Personal account",
        pickerName: "Choose on GitHub",
        pickerHint: "GitHub lists the organisations where you can install the app",
        personalHint: "Your repositories only — ideal for solo use",
        orgHint: "Install on this org — all repositories or a selection on GitHub",
      },
      selectedRepos: {
        label: "Selected repositories",
        hint: "Choose an account above, then on GitHub: Only select repositories and select the repositories to sync.",
      },
      redirectHint: "GitHub will ask which repositories to authorise, then bring you back here. If the redirect fails, come back and click I've installed — continue.",
      continueButton: "I've installed — continue",
      notDetectedHint: "Installation not yet detected. Retry or sign in again via GitHub ({fallbackUrl}).",
      sessionErrorHint: "Session expired or network error — reload the page or sign in again.",
    },
    onboarding: {
      navAriaLabel: "Installation progress",
      step: {
        github: "GitHub login",
        install: "Installation",
        sync: "Sync",
      },
    },
    loading: {
      srOnly: "Loading your session…",
    },
    error: {
      loadSession: "Unable to load your session: {message}",
    },
    signOut: "Sign out",
  },
  sync: {
    halted: {
      title: "Sync interrupted",
      detail: "{reposSynced} / {reposTotal} repos · GitHub authentication error",
    },
    inProgress: {
      title: "Syncing your repositories…",
      detail: "{reposSynced} / {reposTotal} repos · {issueCount} issues",
    },
  },
  dim: {
    label: {
      rows: "Rows",
      cols: "Cols",
      group: "Group",
      orderBy: "Order by",
      subgroup: "Subgroup",
    },
    option: {
      none: "None",
      milestone: "Milestone",
      priority: "Priority",
      repo: "Repo",
      lane: "Lane",
      size: "Size",
      status: "Status",
      parent: "Parent",
      assignee: "Assignee",
    },
    empty: {
      milestone: "No milestone",
      priority: "No priority",
      lane: "No lane",
      size: "No size",
      assignee: "Unassigned",
    },
  },
  graph: {
    toggle: {
      closed: {
        label: "Closed",
        title: "Show closed issues whose parent epic is still open",
      },
      assignees: {
        label: "Assignees",
        title: "Show assignee logins on issue nodes",
      },
    },
    empty: "No issues match the current filter.",
    edgesTitle: "Dependency edges",
    node: {
      title: "#{number} — {title}",
    },
  },
  toolbar: {
    filteredCount: "{count} of {total}",
    display: "Display",
  },
  filter: {
    search: {
      placeholder: "Search issues…",
      ariaLabel: "Search issues",
    },
    facet: {
      status: "Status",
      repo: "Repo",
      milestone: "Milestone",
      priority: "Priority",
      label: "Label",
      assignee: "Assignee",
    },
    epics: {
      label: "Epics",
      title: "Show epics (parent issues)",
    },
    reset: {
      label: "Reset",
    },
    multiselect: {
      noOptions: "No options",
      clear: "Clear {label}",
    },
    empty: {
      milestone: "No milestone",
      priority: "No priority",
      assignee: "Unassigned",
    },
  },
  table: {
    col: {
      status: "Status",
      issue: "Issue",
      title: "Title",
      milestone: "Milestone",
      priority: "Priority",
      lane: "Lane",
      size: "Size",
      blocks: "Blocks",
      blockedBy: "Blocked by",
      parentOf: "Parent of",
    },
    empty: "No issues to show.",
    row: {
      untitled: "untitled",
      stubBadge: "stub",
      epicBadge: "epic",
    },
    card: {
      issueTitle: "Issue #{number}",
    },
  },
  pivot: {
    empty: "No issues match the current filter.",
  },
  status: {
    ready: "Ready",
    blocked: "Blocked",
    running: "Running",
    done: "Done",
  },
  zk: {
    reset: {
      changePassphraseButton: "Change passphrase",
      currentPassphrase: {
        label: "Current passphrase",
      },
      newPassphrase: {
        label: "New passphrase",
      },
      confirmPassphrase: {
        label: "Confirm new passphrase",
      },
      cancel: "Cancel",
      saveButton: "Save passphrase",
      warning: {
        title: "Reset encryption?",
        irreversibleBold: "This action is irreversible.",
        body: "All encrypted issue titles stored for your account on the server will be deleted. Your previously encrypted titles can no longer be decrypted — they are permanently lost. You will choose a new passphrase and re-seal the content from GitHub.",
        githubRequired: "A GitHub connection is required to confirm this action.",
        verifyGithub: "Verify with GitHub",
      },
      execute: {
        title: "Confirm reset",
        description: "GitHub verified. Delete all your encrypted data and set a new passphrase?",
        confirmButton: "Reset and start over",
        errorReauthExpired: "Verification expired — please try again.",
        errorRateLimited: "Too many resets — please try again later.",
        errorGeneric: "Reset failed. Please try again.",
      },
    },
    enroll: {
      title: "Set encryption passphrase",
      description: "Choose a passphrase to protect your encryption key. It never leaves this browser; only an encrypted backup is stored on the server. This device retains your key after setup — the passphrase will be required on other devices or after a lock.",
      passphrase: {
        label: "Passphrase",
      },
      confirmPassphrase: {
        label: "Confirm passphrase",
      },
      remember: {
        label: "Remember passphrase on this device for 30 days",
      },
      submitButton: "Create backup",
      error: {
        tooShort: "The passphrase must be at least 8 characters.",
        mismatch: "Passphrases do not match.",
        alreadyEnrolled: "Already enrolled — unlock with your passphrase instead.",
        generic: "Enrollment failed. Please try again.",
      },
    },
    unlock: {
      title: "Unlock encryption",
      description: "Enter your encryption passphrase to decrypt issue titles and bodies on this device.",
      passphraseLabel: "Passphrase",
      rememberDevice: "Remember the passphrase on this device for 30 days",
      forgotPassword: "Forgot passphrase?",
      submit: "Unlock",
      errorWrongPassphrase: "Incorrect passphrase. Please try again.",
    },
    common: {
      logout: "Log out",
      cancel: "Cancel",
    },
    device2: {
      title: "Complete setup on your original device",
      body1: "Encrypted issue titles on this account were sealed in another browser before passphrase backup was configured. This device cannot decrypt them or complete enrollment until you open Roxabi on your original device to finalise the encryption there.",
      body2Prefix: "Once setup is complete on the original device, you can also",
      linkGithub: "link GitHub",
      body2Suffix: "here to re-seal the content from GitHub.",
      reload: "Reload",
    },
    notice: {
      info: {
        body: "The titles and content of your issues are encrypted and never accessible in plaintext on the server. Your passphrase is not recoverable: if lost, you will need to generate a new one.",
        dismiss: "Close",
      },
      githubLink: {
        body: "Some titles remain encrypted on the server. Link GitHub to import and re-seal their content.",
        cta: "Link GitHub",
      },
      migration: {
        body: "Encryption migration incomplete — some older titles could not be converted. Open Roxabi on the original device to complete it.",
      },
    },
    lock: {
      title: "Lock encryption (clear key from memory)",
      label: "Lock",
    },
    gate: {
      loadingSrOnly: "Unlocking encryption…",
    },
  },
};
