/**
 * Shared GitHub REST helpers — versioned headers + short retry for transient 5xx/429.
 * OAuth and sync paths must stay aligned (oauth.ts previously omitted X-GitHub-Api-Version).
 */

export const GITHUB_REST_API_VERSION = "2022-11-28" as const;

const RETRYABLE = new Set([429, 502, 503, 504]);

export function githubRestHeaders(token?: string): HeadersInit {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    Accept: "application/vnd.github+json",
    "User-Agent": "roxabi-live-worker",
    "X-GitHub-Api-Version": GITHUB_REST_API_VERSION,
  };
}

function retryDelayMs(res: Response, attempt: number): number {
  const retryAfter = Number(res.headers.get("retry-after") || "0");
  if (retryAfter > 0) return retryAfter * 1000;
  return 250 * (attempt + 1);
}

/** GET against api.github.com with versioned headers and bounded retries. */
export async function githubRestGet(
  url: string,
  token: string,
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let last: Response | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      headers: githubRestHeaders(token),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok || !RETRYABLE.has(res.status)) return res;
    last = res;
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, retryDelayMs(res, attempt)));
    }
  }

  return last as Response;
}