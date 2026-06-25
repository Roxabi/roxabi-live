import { BoardView } from "@/components/BoardView";
import { Button } from "@/components/ui/button";
import { useGraphData } from "@/hooks/useGraphData";
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
      <header className="border-b border-border px-6 py-4">
        <span className="text-lg font-semibold tracking-tight text-foreground">Roxabi Live</span>
      </header>
      <main className="p-6">
        <Outlet />
      </main>
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

function CockpitPage() {
  useVersionPoll();
  const { nodes, edges, isLoading, isError, error } = useGraphData();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-foreground">Launch Board</h1>
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

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  component: SignInPage,
});

function SignInPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-8">
        <h1 className="text-xl font-semibold text-foreground">Sign in</h1>
        <p className="text-sm text-muted-foreground">
          Access is gated by Cloudflare Access. Use your email OTP to continue.
        </p>
        <Button className="w-full">Continue with email</Button>
      </div>
    </div>
  );
}

// DEV-only fixture route — lazy so it never enters the production bundle.
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

const routeTree = rootRoute.addChildren([
  indexRoute,
  signInRoute,
  ...(import.meta.env.DEV ? [devTableRoute] : []),
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
