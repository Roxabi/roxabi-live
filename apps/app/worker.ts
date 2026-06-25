export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // TODO: wire service binding to apps/api once worker/ is split
    if (url.pathname.startsWith("/api")) {
      // TODO: proxy to apps/api service binding
      return new Response("API not yet available", { status: 503 });
    }
    // SPA fallback via ASSETS binding
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

interface Env {
  ASSETS: Fetcher;
}
