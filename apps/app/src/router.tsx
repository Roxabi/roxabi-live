import { AuthGate } from "@/auth/AuthGate";
import { useAuth } from "@/auth/AuthContext";
import { SignInScreen } from "@/auth/SignInScreen";
import { AppShell } from "@/components/AppShell";
import { BoardView } from "@/components/BoardView";
import { SyncProgressBanner } from "@/components/SyncProgressBanner";
import { TitleSyncBanner } from "@/components/TitleSyncBanner";
import { useSyncProgressMonitor } from "@/hooks/useSyncProgressMonitor";
import { useVersionPoll } from "@/hooks/useVersionPoll";
import {
  getGithubUserToken,
  hasAttemptedHandoffRefresh,
  refreshGithubTokenViaHandoff,
} from "@/zk/github";
import { ZkGate } from "@/zk/ZkGate";
import { ZkNotices } from "@/zk/ZkNotices";
import { ZkSessionProvider } from "@/zk/ZkSessionProvider";
import { useDecryptedGraph } from "@/zk/useDecryptedGraph";
import type { QueryClient } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Suspense, lazy, useEffect } from "react";

interface RouterContext {
  queryClient: QueryClient;
}

function RootLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Outlet />
    </div>
  );
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: CockpitPage,
});

/** The authenticated dashboard body — mounts only inside ZkGate's unlocked branch. */
function Dashboard() {
  useVersionPoll();
  const me = useAuth();
  const syncStatus = useSyncProgressMonitor();
  const {
    nodes,
    edges,
    repos,
    isLoading,
    isError,
    error,
    needsGithubLink,
    isSyncingTitles,
    syncingTitleCount,
    zkMigrationIncomplete,
  } = useDecryptedGraph();
  // ZK is "active" once the feature flag is on and the user has enrolled a
  // passphrase (zk_key_backups row) — gates the encryption-info banner.
  const zkActive = me.user.zk_account_key_enabled && me.user.zk_enrolled;
  const login = me.user.github_login;

  // Self-heal stale sessions: an already-logged-in ZK user whose seal pass found
  // unsealed titles (needsGithubLink) but has no GitHub token in sessionStorage
  // gets a silent OAuth-handoff bounce to fetch one — so recent issue titles seal
  // without a deco/reco. Guarded to fire at most once per session (inside the
  // helper); no-ops once a token is present.
  useEffect(() => {
    if (zkActive && needsGithubLink) refreshGithubTokenViaHandoff(login);
  }, [zkActive, needsGithubLink, login]);

  // Fallback affordance: only surface the manual "Link GitHub" prompt to an
  // active user once the silent bounce was exhausted (attempted + still no
  // token) — e.g. the server couldn't mint a handoff — so they're never stuck.
  const githubLinkExhausted = hasAttemptedHandoffRefresh(login) && !getGithubUserToken();

  return (
    <div className="space-y-3">
      <ZkNotices
        needsGithubLink={needsGithubLink}
        migrationIncomplete={zkMigrationIncomplete}
        zkActive={zkActive}
        allowGithubLink={githubLinkExhausted}
        githubLogin={login}
      />
      <SyncProgressBanner status={syncStatus} />
      <TitleSyncBanner syncing={isSyncingTitles} count={syncingTitleCount} />
      {isError ? (
        <div className="rounded-lg border border-blocked/30 bg-blocked/10 p-4 text-sm text-blocked">
          Failed to load the corpus: {(error as Error).message}
        </div>
      ) : isLoading ? (
        <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
          Loading the corpus…
        </div>
      ) : (
        <BoardView nodes={nodes} edges={edges} repos={repos} />
      )}
    </div>
  );
}

function CockpitPage() {
  return (
    <AuthGate>
      <ZkSessionProvider>
        <AppShell>
          <ZkGate>
            <Dashboard />
          </ZkGate>
        </AppShell>
      </ZkSessionProvider>
    </AuthGate>
  );
}

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  component: () => <SignInScreen mode="signin" />,
});

const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-up",
  component: () => <SignInScreen mode="signup" />,
});

// DEV-only fixture routes — lazy so they never enter the production bundle.
const DevTablePage = lazy(() => import("./dev/DevTablePage"));
const devTableRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dev/table",
  component: () => (
    <Suspense fallback={null}>
      <DevTablePage />
    </Suspense>
  ),
});

const DevSyncPage = lazy(() => import("./dev/DevSyncPage"));
const devSyncRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dev/sync",
  component: () => (
    <Suspense fallback={null}>
      <DevSyncPage />
    </Suspense>
  ),
});

const DevAuthPage = lazy(() => import("./dev/DevAuthPage"));
const devAuthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dev/auth",
  component: () => (
    <Suspense fallback={null}>
      <DevAuthPage />
    </Suspense>
  ),
});

const DevZkPage = lazy(() => import("./dev/DevZkPage"));
const devZkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dev/zk",
  component: () => (
    <Suspense fallback={null}>
      <DevZkPage />
    </Suspense>
  ),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  signInRoute,
  signUpRoute,
  ...(import.meta.env.DEV ? [devTableRoute, devSyncRoute, devAuthRoute, devZkRoute] : []),
]);

export const router = createRouter({
  routeTree,
  context: { queryClient: undefined as unknown as QueryClient },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
