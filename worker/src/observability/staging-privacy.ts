import type { Env } from "../types";

/** Staging Worker — identified by the staging GitHub App slug in wrangler.toml. */
export function isStagingEnv(env: Env): boolean {
  return env.GITHUB_APP_SLUG === "roxabi-live-staging";
}

const STAGING_ROBOTS_TAG = "noindex, nofollow, noarchive";

/** Crawlers must not index staging even if the URL leaks past the edge gate. */
export function stagingRobotsResponse(): Response {
  return new Response("User-agent: *\nDisallow: /\n", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Robots-Tag": STAGING_ROBOTS_TAG,
      "Cache-Control": "private, no-store",
    },
  });
}

export function applyStagingPrivacyHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", STAGING_ROBOTS_TAG);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
