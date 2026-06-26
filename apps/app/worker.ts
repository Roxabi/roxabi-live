/**
 * apps/app edge worker (app.live.roxabi.dev).
 *
 * Serves the React SPA from ASSETS and proxies API/auth traffic to the apps/api
 * worker over a service binding, so the browser only ever talks to one origin
 * (same-origin). That keeps the session cookie host-only on the app origin and
 * makes the api worker's same-origin CSRF guard pass with no cross-origin CORS.
 * See the monorepo-cutover memo (Option Y).
 *
 * Path prefixes owned by the api worker — everything else is SPA navigation
 * (index "/", /sign-in, /sign-up, deep links) and falls through to ASSETS.
 */
const API_PREFIXES = [
  "/api",
  "/login",
  "/oauth",
  "/auth",
  "/logout",
  "/install",
  "/admin",
  "/health",
];

function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (isApiPath(url.pathname)) {
      // Forward verbatim — the api worker reads the original (app-origin) URL,
      // so OAuth redirect_uri + Set-Cookie + Origin all resolve to app.live.roxabi.dev.
      return env.API.fetch(request);
    }
    // Pages serves static assets in prod; ASSETS exists only in local wrangler.dev.jsonc.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

interface Env {
  ASSETS?: Fetcher;
  API: Fetcher;
}
