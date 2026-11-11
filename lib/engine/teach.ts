// Turning a reviewer's decision into a reusable rule — safely.
//
// The rule itself is built by code from the evidence of the case (which words differ between the
// two names). The AI only interprets the reviewer's plain-English note: should this generalise,
// and to which kinds of business? Then guardrails validate the rule before a person approves it.
import { compareNames, normaliseName } from "./names";
import { HARD_CODES, HARD_LABEL, TaughtRule } from "./policy";
import type { CheckResult } from "./types";

/** Only these reason codes can be taught. Everything else needs a person every time. */
export const TEACHABLE = new Set(["BANK_NAME_NEAR_MATCH", "DOC_NAME_NEAR_MATCH"]);

const GENERIC = new Set(["PRIVATE", "LIMITED", "LLP", "THE", "AND"]);

export type Proposal =
  | { ok: true; rule: TaughtRule; summary: string; names: [string, string] }
  | { ok: false; reason: string };

/** Which check on this case could be taught, if any. */
export function teachableCheck(checks: CheckResult[]) {
  return checks.find((c) => c.outcome === "fail" && c.code && TEACHABLE.has(c.code));
}

export function canTeach(checks: CheckResult[]): { ok: true; check: CheckResult } | { ok: false; reason: string } {
  const hard = checks.find((c) => c.outcome === "fail" && c.code && HARD_CODES.has(c.code));
  if (hard?.code === "POSSIBLE_WATCHLIST_MATCH")
    return { ok: false, reason: "This case is a possible sanctions match. Those are never cleared by a rule: a named person compares the details and records why, every time." };
  if (hard)
    return { ok: false, reason: `This case failed a fraud check: the ${HARD_LABEL[hard.code!] ?? hard.title}. Fraud checks can't be taught or overridden; they protect against paying the wrong party.` };
  const t = teachableCheck(checks);
  if (!t) return { ok: false, reason: "Nothing on this case can be turned into a rule. Only near-matching business names can be taught." };
  return { ok: true, check: t };
}

/** The two names a near-match check compared. */
export function namesFromCheck(c: CheckResult): [string, string] | null {
  const e = c.evidence ?? {};
  if (c.code === "BANK_NAME_NEAR_MATCH") return [String(e.account_holder ?? ""), String(e.compared_with ?? e.trade_name ?? e.legal_name ?? "")];
  if (c.code === "DOC_NAME_NEAR_MATCH") return [String(e.on_document ?? ""), String(e.on_form ?? "")];
  return null;
}

/** Build a name-equivalence rule from the words that differ between the two names. */
export function proposeNameRule(a: string, b: string, scope: string[] | undefined): Proposal {
  const ta = normaliseName(a).split(" ");
  const tb = normaliseName(b).split(" ");
  const common = new Set(ta.filter((t) => tb.includes(t)));
  const da = ta.filter((t) => !common.has(t) && !GENERIC.has(t)).join(" ");
  const db = tb.filter((t) => !common.has(t) && !GENERIC.has(t)).join(" ");
  if (!da || !db) return { ok: false, reason: "The names differ only by words like Private / Limited, which are already handled." };
  const [canonical, other] = da.length <= db.length ? [da, db] : [db, da];
  const rule: TaughtRule = { type: "name_equivalence", phrases: [canonical, other], constitutions: scope };
  const v = validateRule(rule, a, b);
  if (!v.ok) return v;
  const where = scope?.length ? `for ${scope.map(label).join(" / ")} businesses` : "for every kind of business";
  return { ok: true, rule, names: [a, b], summary: `Treat “${canonical}” and “${other}” as the same word in business names, ${where}.` };
}

const label = (c: string) => (c === "proprietor" ? "sole-proprietor" : c);

/**
 * Guardrails a proposed rule must pass before a person can approve it:
 *  1. Only words that describe the business type, never the vendor's own name (no "SHARMA").
 *  2. Short phrases (max 3 words each), so a rule can't smuggle in a whole company name.
 *  3. It must actually resolve the case it came from, and only because the names were already close.
 */
export function validateRule(rule: TaughtRule, a: string, b: string): { ok: true } | { ok: false; reason: string } {
  if (rule.type !== "name_equivalence") return { ok: true };
  const na = normaliseName(a).split(" ");
  const nb = normaliseName(b).split(" ");
  const identity = new Set(na.filter((t) => nb.includes(t) && !GENERIC.has(t) && t !== "COMPANY"));
  for (const p of rule.phrases) {
    const words = p.split(" ");
    if (words.length > 3) return { ok: false, reason: `“${p}” is too long to be a business word. Rules can't name specific companies.` };
    const leaked = words.find((w) => identity.has(w));
    if (leaked) return { ok: false, reason: `“${leaked}” is part of this vendor's own name. Rules must be about business words, not specific vendors.` };
  }
  const before = compareNames(a, b, [], rule.constitutions?.[0]);
  if (before.verdict === "mismatch") return { ok: false, reason: "The names are not close enough. A rule can only settle near-matches." };
  const after = compareNames(a, b, [{ phrases: rule.phrases, constitutions: rule.constitutions }], rule.constitutions?.[0] ?? "");
  if (after.verdict !== "match") return { ok: false, reason: "This rule would not resolve the case it came from." };
  return { ok: true };
}

/** Fallback reading of the reviewer's note when the AI is unavailable. */
export function interpretNoteByRules(note: string, constitution: string) {
  const n = note.toLowerCase();
  const oneOff = /\b(only this|one[- ]off|just this|this time|this vendor only|called|phoned|confirmed with)\b/.test(n);
  const all = /\b(all|any|every)\b.*\b(business|vendor|compan)/.test(n);
  const prop = /proprietor/.test(n) || /proprietor/i.test(constitution);
  return {
    generalise: !oneOff,
    scope: all ? undefined : prop ? ["proprietor"] : [constitution.toLowerCase()],
    why: oneOff ? "The note describes a one-off check, so no rule is suggested." : "The note describes a general pattern.",
  };
}
