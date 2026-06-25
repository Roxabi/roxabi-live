import { AuthGate } from "@/auth/AuthGate";
import { SignInScreen } from "@/auth/SignInScreen";
import { AppShell } from "@/components/AppShell";
import { BoardView } from "@/components/BoardView";
import { SyncProgressBanner } from "@/components/SyncProgressBanner";
import { useGraphData } from "@/hooks/useGraphData";
import { useSyncProgressMonitor } from "@/hooks/useSyncProgressMonitor";
import { useVersionPoll } from "@/hooks/useVersionPoll";
import type { QueryClient } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Suspense, lazy } from "react";

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

/** The authenticated dashboard body — mounts only inside AuthGate's ready branch. */
function Dashboard() {
  useVersionPoll();
  const syncStatus = useSyncProgressMonitor();
  const { nodes, edges, isLoading, isError, error } = useGraphData();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-foreground">Launch Board</h1>
      <SyncProgressBanner status={syncStatus} />
      {isError ? (
        <div className="rounded-lg border border-blocked/30 bg-blocked/10 p-4 text-sm text-blocked">
          Failed to load the corpus: {(error as Error).message}
        </div>
      ) : isLoading ? (
        <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
          Loading the corpus…
        </div>
      ) : (
        <BoardView nodes={nodes} edges={edges} />
      )}
    </div>
  );
}

function CockpitPage() {
  return (
    <AuthGate>
      <AppShell>
        <Dashboard />
      </AppShell>
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

const routeTree = rootRoute.addChildren([
  indexRoute,
  signInRoute,
  signUpRoute,
  ...(import.meta.env.DEV ? [devTableRoute, devSyncRoute, devAuthRoute] : []),
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
