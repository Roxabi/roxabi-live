/**
 * Label vocabulary + issue-key helpers for the corpus sync engine.
 *
 * Pure functions and constants (regexes, lane/size/priority vocab maps) plus
 * GraphQL edge collection — no D1, no network. Verbatim port of the parsing
 * helpers from sync.py. Split out of sync.ts (file-length gate).
 */

const _BARE_INT = /^\d+$/;
const _SHORT_FORM = /^#(\d+)$/;
const _FULL_KEY = /^[\w.-]+\/[\w.-]+#\d+$/;
export const BRANCH_ISSUE_RE = /^(?:[a-z]+\/)?(\d+)-/;

// ---------------------------------------------------------------------------
// Vocab maps (verbatim from sync.py)
// ---------------------------------------------------------------------------

const _LANE_PREFIX = "graph:lane/";
const _SIZE_PREFIX = "size:";
const _LEGACY_SIZE_MAP: Record<string, string> = { M: "F-lite" };
const _LEGACY_SIZE_RAW = new Set(["XS", "S", "M", "L", "XL"]);
const _PRIORITY_EXACT: Record<string, string> = {
  P0: "P0",
  "P0-critical": "P0",
  "priority:P0": "P0",
  "P1-high": "P1",
  "priority:high": "P1",
  "priority:P1": "P1",
  "P2-medium": "P2",
  "priority:medium": "P2",
  "priority:P2": "P2",
  "P3-low": "P3",
  "priority:low": "P3",
  "priority: low": "P3",
  "priority:P3": "P3",
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Derive lane/priority/size from a label list. First match wins per field. */
export function extractFromLabels(labels: string[]): {
  lane: string | null;
  priority: string | null;
  size: string | null;
} {
  let lane: string | null = null;
  let priority: string | null = null;
  let size: string | null = null;

  for (const lbl of labels) {
    if (lane === null && lbl.startsWith(_LANE_PREFIX)) {
      lane = lbl.slice(_LANE_PREFIX.length);
    }
    if (priority === null && lbl in _PRIORITY_EXACT) {
      priority = _PRIORITY_EXACT[lbl];
    }
    if (size === null && lbl.startsWith(_SIZE_PREFIX)) {
      const raw = lbl.slice(_SIZE_PREFIX.length);
      size = _LEGACY_SIZE_MAP[raw] ?? raw;
    }
  }
  // Legacy fallback for bare size labels (only if size: prefix not found)
  if (size === null) {
    for (const lbl of labels) {
      if (_LEGACY_SIZE_RAW.has(lbl)) {
        size = lbl;
        break;
      }
    }
  }

  return { lane, priority, size };
}

/**
 * Canonicalise an issue reference to 'owner/repo#N' form.
 *
 *   42 + 'Roxabi/lyra'          → 'Roxabi/lyra#42'
 *   '42' + 'Roxabi/lyra'        → 'Roxabi/lyra#42'
 *   '#9' + 'Roxabi/lyra'        → 'Roxabi/lyra#9'
 *   'Roxabi/voiceCLI#7' + _any_ → 'Roxabi/voiceCLI#7'
 */
export function canonicalKey(ref: number | string, repo: string): string {
  if (typeof ref === "number") return `${repo}#${ref}`;
  const s = String(ref);
  if (_FULL_KEY.test(s)) return s;
  const mShort = _SHORT_FORM.exec(s);
  if (mShort) return `${repo}#${mShort[1]}`;
  if (_BARE_INT.test(s)) return `${repo}#${s}`;
  throw new Error(`Cannot canonicalise issue ref: ${JSON.stringify(ref)}`);
}

// ---------------------------------------------------------------------------
// Edge collection
// ---------------------------------------------------------------------------

export interface EdgeData {
  parents: string[];
  children: string[];
  blockedBy: string[];
  blocking: string[];
}

type IssueNode = {
  number: number;
  subIssues?: { nodes: Array<{ number: number; repository: { nameWithOwner: string } }> };
  parent?: { number: number; repository: { nameWithOwner: string } } | null;
  blockedBy?: { nodes: Array<{ number: number; repository: { nameWithOwner: string } }> };
  blocking?: { nodes: Array<{ number: number; repository: { nameWithOwner: string } }> };
};

/** Collect edge references from a GraphQL issue node into collectedEdges map. */
export function collectEdges(
  node: IssueNode,
  _repo: string,
  key: string,
  collectedEdges: Map<string, EdgeData>,
): void {
  const children = (node.subIssues?.nodes ?? []).map((t) =>
    canonicalKey(t.number, t.repository.nameWithOwner),
  );
  const parentNode = node.parent ?? null;
  const parents = parentNode
    ? [canonicalKey(parentNode.number, parentNode.repository.nameWithOwner)]
    : [];
  const blockedBy = (node.blockedBy?.nodes ?? []).map((t) =>
    canonicalKey(t.number, t.repository.nameWithOwner),
  );
  const blocking = (node.blocking?.nodes ?? []).map((t) =>
    canonicalKey(t.number, t.repository.nameWithOwner),
  );

  collectedEdges.set(key, { parents, children, blockedBy, blocking });
}
