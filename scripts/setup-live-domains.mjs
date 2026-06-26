#!/usr/bin/env node
/**
 * Ensure DNS CNAMEs for roxabi-live Pages frontends (SSOT: infra/live-domains.json).
 *
 * Usage:
 *   source scripts/bw-cloudflare-global-env.sh
 *   node scripts/setup-live-domains.mjs [--dry-run]
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertCfCredentials, cf } from "./lib/cf-access.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(readFileSync(join(ROOT, "infra/live-domains.json"), "utf8"));
const DRY_RUN = process.argv.includes("--dry-run");

function log(msg) {
  console.log(DRY_RUN ? `[dry-run] ${msg}` : msg);
}

async function getZone(name) {
  const zones = await cf(`/zones?name=${name}`);
  return zones[0] ?? null;
}

async function listDns(zoneId) {
  return cf(`/zones/${zoneId}/dns_records?per_page=500`);
}

async function ensureDnsRecord(zoneId, zoneName, spec) {
  const fqdn =
    spec.name === "@" ? zoneName : spec.name.includes(".") ? spec.name : `${spec.name}.${zoneName}`;
  const existing = (await listDns(zoneId)).find(
    (r) => r.type === spec.type && r.name === fqdn && r.content === spec.content,
  );
  if (existing) {
    log(`✓ DNS exists ${spec.type} ${fqdn} → ${spec.content}`);
    return existing;
  }

  const stale = (await listDns(zoneId)).find((r) => r.name === fqdn && r.type !== spec.type);
  if (stale) {
    log(`~ DNS replace ${stale.type} ${fqdn} (${stale.content}) → ${spec.type} ${spec.content}`);
    if (!DRY_RUN) {
      await cf(`/zones/${zoneId}/dns_records/${stale.id}`, { method: "DELETE" });
    }
  }

  const body = {
    type: spec.type,
    name: spec.name,
    content: spec.content,
    proxied: spec.proxied ?? true,
    ttl: 1,
    comment: spec.comment,
  };

  log(`+ DNS ${spec.type} ${fqdn} → ${spec.content}${spec.comment ? ` (${spec.comment})` : ""}`);
  if (DRY_RUN) return null;
  return cf(`/zones/${zoneId}/dns_records`, { method: "POST", body: JSON.stringify(body) });
}

async function main() {
  assertCfCredentials();

  const zone = await getZone(CONFIG.zone);
  if (!zone) throw new Error(`Zone ${CONFIG.zone} not found`);

  for (const spec of CONFIG.records) {
    await ensureDnsRecord(zone.id, CONFIG.zone, spec);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});