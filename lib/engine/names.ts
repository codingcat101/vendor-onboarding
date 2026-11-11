// Business-name normalisation and matching.
// Policy v1 is deliberately conservative: only names that are identical after standard
// normalisation (PVT -> PRIVATE, punctuation, M/S prefix...) count as a match. Anything
// close goes to a person. Reviewers can teach extra equivalences (see policy.ts).

const ABBREVIATIONS: [RegExp, string][] = [
  [/\bPVT\b/g, "PRIVATE"],
  [/\bPRIV\b/g, "PRIVATE"],
  [/\bLTD\b/g, "LIMITED"],
  [/\bCO\b/g, "COMPANY"],
  [/\bCORP\b/g, "CORPORATION"],
  [/\bINC\b/g, "INCORPORATED"],
  [/\bL\.?L\.?C\b\.?/g, "LLC"],
  [/\bMFG\b/g, "MANUFACTURING"],
  [/\bENGG\b/g, "ENGINEERING"],
  [/\bINTL\b/g, "INTERNATIONAL"],
  [/\bSVCS\b/g, "SERVICES"],
  [/&/g, " AND "],
];

/** Words that say what kind of entity it is, not who it is. Ignored for similarity scoring. */
const GENERIC = new Set(["PRIVATE", "LIMITED", "LLP", "LLC", "COMPANY", "THE", "AND", "INCORPORATED", "CORPORATION"]);

export interface Equivalence {
  /** Phrases treated as the same, e.g. ["TRADERS", "TRADING COMPANY"]. Already normalised. */
  phrases: string[];
  /** Only apply for these constitutions (lower-case substring match). Empty = all. */
  constitutions?: string[];
}

export function normaliseName(raw: string | undefined | null): string {
  let s = ` ${(raw ?? "").toUpperCase()} `;
  s = s.replace(/^\s*M\/S\.?\s+/, " ");
  for (const [re, rep] of ABBREVIATIONS) s = s.replace(re, rep);
  s = s.replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  // drop a bare "COMPANY" left over from things like "& Co." on its own? keep; it's meaningful.
  return s;
}

export function applyEquivalences(name: string, eqs: Equivalence[], constitution?: string): string {
  let s = ` ${name} `;
  for (const eq of eqs) {
    if (eq.constitutions?.length && !eq.constitutions.some((c) => (constitution ?? "").toLowerCase().includes(c))) continue;
    const canonical = eq.phrases[0];
    const sorted = [...eq.phrases].sort((a, b) => b.length - a.length);
    for (const p of sorted) s = s.replace(new RegExp(` ${escapeRe(p)} `, "g"), ` ${canonical} `);
  }
  return s.trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function distinctive(name: string) {
  return name.split(" ").filter((t) => t && !GENERIC.has(t)).join(" ");
}

/** Jaro-Winkler similarity, 0..1. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false);
  const bm = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (!bm[j] && a[i] === b[j]) {
        am[i] = bm[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

function tokenDice(a: string, b: string) {
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export type NameMatch = { verdict: "match" | "near" | "mismatch"; score: number; a: string; b: string; ruleApplied?: boolean };

export const NEAR_MATCH_THRESHOLD = 0.8;

/**
 * Compare two business names.
 * - match:    identical after normalisation (+ any taught equivalences)
 * - near:     similar enough that a person should look (score >= 0.80)
 * - mismatch: clearly a different name
 */
export function compareNames(
  x: string | undefined,
  y: string | undefined,
  eqs: Equivalence[] = [],
  constitution?: string,
): NameMatch {
  const a0 = normaliseName(x);
  const b0 = normaliseName(y);
  if (a0 === b0) return { verdict: "match", score: 1, a: a0, b: b0 };
  // Names that differ only by generic words (e.g. "X PRIVATE LIMITED" vs "X LIMITED") -> a person looks.
  if (distinctive(a0) === distinctive(b0)) return { verdict: "near", score: 0.95, a: a0, b: b0 };
  const da = distinctive(a0);
  const db = distinctive(b0);
  const score = Math.round(Math.max(jaroWinkler(da, db), tokenDice(da, db)) * 100) / 100;
  if (score < NEAR_MATCH_THRESHOLD) {
    // GUARDRAIL: taught rules are never consulted for a clear mismatch. A reviewer can teach the
    // system to resolve near-matches, but no rule can make an unrelated name count as the vendor.
    return { verdict: "mismatch", score, a: a0, b: b0 };
  }
  const a = applyEquivalences(a0, eqs, constitution);
  const b = applyEquivalences(b0, eqs, constitution);
  if (a === b || distinctive(a) === distinctive(b)) return { verdict: "match", score: 1, a, b, ruleApplied: true };
  return { verdict: "near", score, a: a0, b: b0 };
}

/** Best match of `name` against any of several candidate names. */
export function bestMatch(name: string, candidates: (string | undefined)[], eqs: Equivalence[] = [], constitution?: string) {
  const order = { match: 2, near: 1, mismatch: 0 } as const;
  let best: (NameMatch & { against: string }) | null = null;
  for (const c of candidates) {
    if (!c) continue;
    const m = compareNames(name, c, eqs, constitution);
    if (!best || order[m.verdict] > order[best.verdict] || (m.verdict === best.verdict && m.score > best.score))
      best = { ...m, against: c };
  }
  return best ?? { verdict: "mismatch" as const, score: 0, a: name, b: "", against: "" };
}
