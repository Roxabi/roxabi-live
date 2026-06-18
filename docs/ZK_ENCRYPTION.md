# Client-side encryption (ZK account key)

Roxabi Live encrypts issue **titles and bodies** in your browser before anything is stored in D1. The server keeps **graph structure** (state, blockers, labels, milestones) visible to operators; content is per-user ciphertext.

This is **client-side encryption**, not strict zero-knowledge. The operator cannot read stored ciphertext or your passphrase, but structural metadata is visible, sync uses a GitHub App token for structure, and served JavaScript is a residual trust surface. See `docs/zk-account-key-design.md` for the full threat model.

---

## How it works

1. **Enrollment** — You choose a passphrase. Argon2id derives a wrapping key; your random `accountKey` is wrapped and stored in D1 (`zk_key_backups`). The passphrase never leaves the browser.
2. **Unlock** — On each device/session you enter the passphrase to unwrap `accountKey` into memory (15-minute idle lock).
3. **Seal** — Titles/bodies are encrypted with `accountKey` and uploaded to `zk_payloads`. D1 plaintext titles for those issues are scrubbed.
4. **Decrypt** — The dashboard fetches your ciphertext rows and decrypts locally after unlock.

Issue content can also be fetched from GitHub with your **user OAuth token** (tab-scoped) to re-seal or sync bodies — see **Link GitHub** in the operator notice.

---

## Multi-device

| Scenario | What to do |
|----------|------------|
| **New laptop / browser** | Sign in → unlock with the same passphrase → titles decrypt via D1 backup. |
| **Lost passphrase** | Ciphertext cannot be recovered. Re-link GitHub and re-seal from GitHub if you still have repo access. |
| **Sealed on Device 1 before backup** | Complete enrollment on the original device first, or use Link GitHub on the new device to re-seal from GitHub. |

---

## Hybrid multi-user (same org installation)

Graph rows (`issues`, `edges`) are **shared** across teammates on one GitHub App installation. Ciphertext in `zk_payloads` is **per user** — there is no team passphrase.

| What you see | Why |
|--------------|-----|
| Structure (state, edges, labels) | Shared canonical graph in D1. |
| `(sealed)` on a title | Another teammate sealed that issue, or you have not sealed/decrypted it yet. |
| Your decrypted titles | You enrolled, unlocked, and have a `zk_payloads` row for that issue. |

**Product copy:** Each teammate encrypts their own view of issue titles. You will see `(sealed)` until you link GitHub and sync.

**FAQ**

- *Why does my teammate see titles but I see (sealed)?* — They sealed with their key; you have not linked GitHub and sealed yet.
- *Can we share one team passphrase?* — No. Shared org keys are intentionally not supported.

When **any** user seals an issue, API responses redact that issue’s title for **everyone** (`title: null` from `/api/graph`). Each user independently fetches from GitHub and seals with their own `accountKey`.

---

## Server sync (structure-only)

When `ZK_STRUCTURE_ONLY` is enabled, cron and webhooks persist structure and metadata only — no title/body from GitHub on the server path. Combined with client sealing, operators do not receive issue content via sync.

---

## Further reading

- Design: `docs/zk-account-key-design.md`
- Architecture pointer: `docs/ARCHITECTURE.md` (ZK section)
- Implementation: `frontend/zk-crypto.js`, `frontend/zk-enroll.js`, `worker/src/api/zk-key-backup.ts`, `worker/src/api/zk-payloads.ts`