/**
 * parse.ts — milestone string parser for the v6 graph API.
 *
 * Ported from src/roxabi_live/dep_graph/v6/parse.py::parse_milestone.
 * Regex patterns are character-for-character identical to the Python source.
 *
 * NOTE: derive_priority / derive_lane_size are intentionally NOT ported here.
 * Those are sync-time concerns handled by extractFromLabels in sync.ts, which
 * writes lane/priority/size columns at upsert time. This module covers only the
 * read-path milestone parsing needed by the graph API.
 */

const MILESTONE_MN = /^M(\d+)\s*[—–-]\s*(.+)$/;
const MILESTONE_PHASE = /^Phase\s+(\d+)\s*[—–-]\s*(.+)$/;

export interface ParsedMilestone {
  code: string | null;
  name: string | null;
  sortKey: number;
}

/**
 * Parse a raw milestone string into { code, name, sortKey }.
 *
 * Formats handled:
 *   "M0 — NATS hardening"   → { code:"M0",  name:"NATS hardening",   sortKey:0   }
 *   "M10 — Social Media"    → { code:"M10", name:"Social Media",      sortKey:10  }
 *   "Phase 0 — Foundation"  → { code:"Ph0", name:"Foundation",        sortKey:100 }
 *   "Phase 5 — Security"    → { code:"Ph5", name:"Security",          sortKey:105 }
 *   "Final Initiatives"     → { code:"FIN", name:"Final Initiatives", sortKey:999 }
 *   null                    → { code:null,  name:null,                sortKey:1000 }
 *   unknown text            → { code:null,  name:raw,                 sortKey:1000 }
 */
export function parseMilestone(raw: string | null): ParsedMilestone {
  if (raw === null) {
    return { code: null, name: null, sortKey: 1000 };
  }

  const mMN = MILESTONE_MN.exec(raw);
  if (mMN) {
    const n = Number.parseInt(mMN[1], 10);
    return { code: `M${n}`, name: mMN[2].trim(), sortKey: n };
  }

  const mPhase = MILESTONE_PHASE.exec(raw);
  if (mPhase) {
    const n = Number.parseInt(mPhase[1], 10);
    return { code: `Ph${n}`, name: mPhase[2].trim(), sortKey: 100 + n };
  }

  if (raw.trim() === "Final Initiatives") {
    return { code: "FIN", name: "Final Initiatives", sortKey: 999 };
  }

  return { code: null, name: raw, sortKey: 1000 };
}
