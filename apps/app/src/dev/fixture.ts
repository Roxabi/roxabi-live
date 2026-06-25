/**
 * fixture.ts — a representative /api/graph payload for local browser
 * verification, used only by the DEV-gated /dev/table route. It exercises every
 * status path the real corpus produces so CSS/cascade and annotate logic can be
 * eyeballed without an authenticated session:
 *
 *   - done (closed), blocked (open blocker), ready, ready+active (running),
 *   - an open epic whose blocked status propagates to a child,
 *   - a closed child under that epic (done wins over propagation), a stub.
 */

import type { GraphResponse } from "@roxabi-live/shared";

function node(
  p: Partial<GraphResponse["nodes"][number]> & { key: string },
): GraphResponse["nodes"][number] {
  const [repo, num] = p.key.split("#");
  return {
    repo,
    number: Number(num),
    title: null,
    state: "open",
    dev_state: "idle",
    url: `https://github.com/${repo}/issues/${num}`,
    milestone: null,
    milestone_code: null,
    milestone_name: null,
    milestone_sort_key: 9999,
    labels: [],
    priority: null,
    lane: null,
    size: null,
    status: null,
    is_stub: false,
    assignees: [],
    ...p,
  };
}

export const fixtureGraph: GraphResponse = {
  nodes: [
    node({
      key: "Roxabi/roxabi-live#270",
      title: "Ship the React cockpit",
      state: "open",
      milestone_code: "M2",
      milestone_sort_key: 2,
      priority: "P1",
      lane: "e",
      size: "L",
      labels: ["area:frontend", "size:L", "priority:P1"],
      assignees: ["mickael"],
    }),
    node({
      key: "Roxabi/roxabi-live#271",
      title: "Monorepo migration",
      state: "open",
      dev_state: "pr_open",
      milestone_code: "M2",
      milestone_sort_key: 2,
      priority: "P0",
      lane: "e",
      size: "XL",
      labels: ["area:infra"],
      assignees: ["mickael", "roxabi-ci"],
    }),
    node({
      key: "Roxabi/roxabi-factory#1672",
      title: "Spec freeze",
      state: "open",
      milestone_code: "M1",
      milestone_sort_key: 1,
      priority: "P2",
      lane: "b",
      size: "M",
    }),
    node({
      key: "Roxabi/roxabi-factory#1671",
      title: "factory-* rename epic",
      state: "open",
      milestone_code: "M1",
      milestone_sort_key: 1,
      priority: "P2",
    }),
    node({
      key: "Roxabi/roxabi-factory#1700",
      title: "Cutover hub config",
      state: "open",
      milestone_code: "M1",
      milestone_sort_key: 1,
      priority: "P1",
    }),
    node({
      key: "Roxabi/roxabi-factory#1699",
      title: "Archive legacy seed",
      state: "closed",
      milestone_code: "M1",
      milestone_sort_key: 1,
      priority: "P3",
    }),
    node({
      key: "Roxabi/voiceCLI#88",
      title: "TTS latency budget",
      state: "open",
      dev_state: "pr_reviewed",
      milestone_code: "M3",
      milestone_sort_key: 3,
      priority: "P1",
    }),
    node({
      key: "Roxabi/llmCLI#142",
      title: "LiteLLM proxy HA",
      state: "open",
      milestone_code: "M3",
      milestone_sort_key: 3,
      priority: "P2",
    }),
    node({
      key: "Roxabi/roxabi-live#255",
      title: "release-please removal",
      state: "closed",
      milestone_code: "M2",
      milestone_sort_key: 2,
      priority: "P2",
    }),
    node({ key: "Roxabi/roxabi-live#999", title: null, state: "open", is_stub: true }),
  ],
  edges: [
    // #270 is blocked by the still-open monorepo migration #271.
    { src: "Roxabi/roxabi-live#271", dst: "Roxabi/roxabi-live#270", kind: "blocks" },
    // Open #1672 blocks the epic #1671 → #1671 is blocked directly...
    { src: "Roxabi/roxabi-factory#1672", dst: "Roxabi/roxabi-factory#1671", kind: "blocks" },
    // ...and that 'blocked' propagates down its children: #1700 (open) inherits
    // blocked; #1699 (closed) stays 'done' (closed always wins).
    { src: "Roxabi/roxabi-factory#1671", dst: "Roxabi/roxabi-factory#1700", kind: "parent" },
    { src: "Roxabi/roxabi-factory#1671", dst: "Roxabi/roxabi-factory#1699", kind: "parent" },
    // voiceCLI#88 blocks llmCLI#142.
    { src: "Roxabi/voiceCLI#88", dst: "Roxabi/llmCLI#142", kind: "blocks" },
  ],
  repos: [
    {
      repo: "Roxabi/roxabi-live",
      archived: false,
      is_private: false,
      issue_count: 4,
      last_updated_at: "2026-06-25T00:00:00Z",
    },
    {
      repo: "Roxabi/roxabi-factory",
      archived: false,
      is_private: true,
      issue_count: 3,
      last_updated_at: "2026-06-24T00:00:00Z",
    },
    {
      repo: "Roxabi/voiceCLI",
      archived: false,
      is_private: true,
      issue_count: 1,
      last_updated_at: "2026-06-23T00:00:00Z",
    },
    {
      repo: "Roxabi/llmCLI",
      archived: false,
      is_private: true,
      issue_count: 1,
      last_updated_at: "2026-06-22T00:00:00Z",
    },
  ],
};
