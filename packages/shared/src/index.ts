/**
 * @roxabi-live/shared — the cross-app contract.
 *
 * Phase 1: brand token mirror only. Step 2 will grow this into the SSOT that
 * apps/api (Hono Worker) + apps/app (React SPA) + apps/marketing (Astro) all
 * import — Zod schemas for the issue/edge corpus, shared types, status logic,
 * i18n keys — mirroring enishu's packages/shared.
 */

export * as brand from "./brand.ts";
export { status, statusColor, type StatusKey } from "./brand.ts";

// The Worker HTTP API contract — shared by apps/app and (later) apps/api.
export * from "./types.ts";

// Pure graph status + annotation logic (ported from frontend/state.js).
export * from "./graph.ts";
