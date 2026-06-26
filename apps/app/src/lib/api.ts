/**
 * api.ts — thin fetch wrapper for the Worker HTTP API.
 *
 * - Same-origin by default (the app is served by the Worker via ASSETS today;
 *   after the app.live cutover the same Worker still owns /api). `VITE_API_BASE`
 *   overrides the base for local dev against a remote Worker.
 * - `credentials: "include"` so the session cookie rides along.
 * - Throws `ApiError` on any non-2xx so TanStack Query surfaces the failure.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Base URL for the Worker API. Empty string = same-origin. */
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

type QueryValue = string | number | boolean | undefined | null;

export interface ApiRequestOptions extends Omit<RequestInit, "body"> {
  /** JSON request body — serialized and Content-Type set automatically. */
  body?: unknown;
  /** Query params appended to the path; undefined/null entries are skipped. */
  query?: Record<string, QueryValue>;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = API_BASE + path;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return res.json();
  return res.text();
}

export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { body, query, headers, ...rest } = options;
  const init: RequestInit = {
    credentials: "include",
    ...rest,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(buildUrl(path, query), init);
  const parsed = await parseBody(res);

  if (!res.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message, parsed);
  }
  return parsed as T;
}
