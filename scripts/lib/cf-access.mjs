export const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? "b5e90be971920ce406f7b679c4f1cd33";

// Workers Builds config API needs the admin token; wrangler deploy uses the build token.
const TOKEN =
  process.env.CLOUDFLARE_BUILDS_ADMIN_TOKEN ??
  process.env.CF_API_TOKEN ??
  process.env.CLOUDFLARE_API_TOKEN;
const CF_EMAIL = process.env.CLOUDFLARE_EMAIL ?? process.env.CF_EMAIL;
const CF_KEY = process.env.CLOUDFLARE_API_KEY ?? process.env.CF_KEY;

export function assertCfCredentials() {
  if (!TOKEN && !(CF_EMAIL && CF_KEY)) {
    throw new Error(
      "Missing CLOUDFLARE_BUILDS_ADMIN_TOKEN (preferred) or CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY",
    );
  }
}

function cfAuthHeaders() {
  if (TOKEN) return { Authorization: `Bearer ${TOKEN}` };
  if (CF_EMAIL && CF_KEY) return { "X-Auth-Email": CF_EMAIL, "X-Auth-Key": CF_KEY };
  return {};
}

export async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      ...cfAuthHeaders(),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!text) {
    if (!res.ok) throw new Error(`CF API ${path}: HTTP ${res.status}`);
    return null;
  }
  const json = JSON.parse(text);
  if (!json.success) {
    throw new Error(`CF API ${path}: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.result;
}