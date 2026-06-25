export { fr } from "./fr";
export { en } from "./en";
export type { Translations } from "./fr";

// ── Board data (shared, untranslated) ────────────────────────────────────────
// Issue card titles, repo names, issue refs, and status words are intentionally
// kept in French / technical English as-is — they are board-level technical data.
export const BOARD = [
  {
    repo: "roxabi-factory",
    count: 4,
    issues: [
      { num: "#847", status: "ready",   title: "Ajout plugin webhook NATS" },
      { num: "#851", status: "ready",   title: "Docs API publique" },
      { num: "#839", status: "running", title: "Refactor clipool worker", agent: "A1", agentLabel: "agent-1" },
      { num: "#855", status: "blocked", title: "Migrate vers bun workspace", blockedBy: "#839" },
    ],
  },
  {
    repo: "voiceCLI",
    count: 3,
    issues: [
      { num: "#204", status: "ready",   title: "Support Chatterbox v2" },
      { num: "#198", status: "running", title: "Streaming STT pipeline", agent: "A2", agentLabel: "agent-2" },
      { num: "#191", status: "done",    title: "Config Quadlet voicecli-tts" },
    ],
  },
  {
    repo: "llmCLI",
    count: 3,
    issues: [
      { num: "#312", status: "ready",   title: "Fallback provider chain" },
      { num: "#318", status: "blocked", title: "Rate-limit par tenant", blockedBy: "#312" },
      { num: "#307", status: "done",    title: "LiteLLM proxy config M1" },
    ],
  },
] as const;

export type BoardIssue = {
  num: string;
  status: "ready" | "running" | "blocked" | "done";
  title: string;
  agent?: string;
  agentLabel?: string;
  blockedBy?: string;
};
export type BoardCol = {
  repo: string;
  count: number;
  issues: readonly BoardIssue[];
};
