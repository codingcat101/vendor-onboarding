// Plain-English requirements → structured rules the code enforces.
// "Require $1M liability coverage for all IT vendors" becomes
// { doc: insurance_certificate, min_liability: 1000000, currency: USD, applies_to: { categories: ["IT services / data analytics"] } }.
// The AI (or, if it is unavailable, the keyword parser below) only interprets the sentence;
// code validates the result, a dry run shows its effect, and a person approves it.
import { CATEGORIES, type Currency, type Policy, type Requirement, describeScope, fmtMoney } from "./policy";
import type { Tier } from "./types";

export type RequirementDraft = Omit<Requirement, "id" | "added_by">;

/** Requests that would loosen controls. Requirements may only add or raise checks. */
const WEAKENING = /\b(skip|waive|exempt|ignore|remove|drop|relax|lower|reduce|bypass|auto[- ]?approve|don'?t (require|check|need|ask)|do not (require|check|need|ask)|no need|not required|without)\b/i;

const CATEGORY_WORDS: [RegExp, string][] = [
  [/\b(it|software|tech(nology)?|saas|data|analytics|cloud)\b/i, "IT services / data analytics"],
  [/\b(logistics?|freight|transport(ation)?|shipping|courier|trucking)\b/i, "Logistics"],
  [/\b(payroll|hr|human resources)\b/i, "Payroll & HR services"],
  [/\b(housekeeping|cleaning|janitorial|facilit(y|ies))\b/i, "Housekeeping services"],
  [/\b(print(ing)?|signage)\b/i, "Printing & signage"],
  [/\bpackag(ing|e)\b/i, "Packaging materials"],
  [/\b(stationery|office supplies)\b/i, "Office stationery"],
  [/\belectrical\b/i, "Electrical supplies"],
  [/\b(hardware|tools)\b/i, "Hardware & tools"],
  [/\b(machin(ed|ing)|manufactur(ing|er|ers)|components?)\b/i, "Machined components"],
  [/\b(consult(ing|ants?)|professional services|legal|accounting)\b/i, "Professional services"],
];

export const LOOSEN_REASON = "Requirements can only add or raise checks. They can't remove a document, lower a minimum, relax a fraud check or approve vendors. A person changes those directly.";
export const loosensControls = (text: string) => WEAKENING.test(text);

/** "$1M", "$1,000,000", "1 million dollars", "₹1 crore", "Rs 50 lakh", "£2m" → amount + currency. */
export function parseAmount(text: string): { amount: number; currency: Currency } | null {
  const t = text.replace(/,/g, "");
  const m =
    t.match(/(\$|usd|us\$|₹|rs\.?|inr|£|gbp)\s*(\d+(?:\.\d+)?)\s*(million|mn|m|thousand|k|crores?|cr|lakhs?|lacs?|l)?\b/i) ??
    t.match(/(\d+(?:\.\d+)?)\s*(million|mn|m|thousand|k|crores?|cr|lakhs?|lacs?)?\s*(dollars|usd|rupees|inr|pounds|gbp)\b/i);
  if (!m) return null;
  const [sym, num, unit] = /^\d/.test(m[1]) ? [m[3], m[1], m[2]] : [m[1], m[2], m[3]];
  const s = sym.toLowerCase();
  const currency: Currency = /^(₹|rs\.?|inr|rupees?)$/.test(s) ? "INR" : /^(£|gbp|pounds?)$/.test(s) ? "GBP" : "USD";
  const u = (unit ?? "").toLowerCase();
  const mult = /^(million|mn|m)$/.test(u) ? 1e6 : /^(thousand|k)$/.test(u) ? 1e3 : /^(crores?|cr)$/.test(u) ? 1e7 : /^(lakhs?|lacs?|l)$/.test(u) ? 1e5 : 1;
  return { amount: Math.round(Number(num) * mult), currency };
}

/** Keyword interpretation, used when the AI is unavailable (and as a cross-check in tests). */
export function parseRequirementByRules(text: string): RequirementDraft | { error: string } {
  if (!/insur|liabilit|coverage|cover\b|coi\b/i.test(text))
    return { error: "I can only turn insurance requirements into rules for now, e.g. “Require $1M liability coverage for all IT vendors”." };
  const amt = parseAmount(text);
  if (!amt) return { error: "I couldn't find an amount. Say it like “$1M”, “$2,000,000” or “₹1 crore”." };
  const categories = CATEGORY_WORDS.filter(([re]) => re.test(text)).map(([, c]) => c);
  const countries = [
    /\b(us|usa|u\.s\.|american|united states)\b/i.test(text) ? "US" : "",
    /\b(india|indian)\b/i.test(text) ? "IN" : "",
    /\b(uk|british|united kingdom)\b/i.test(text) ? "GB" : "",
  ].filter(Boolean);
  const tiers = (["LOW", "STANDARD", "STRATEGIC"] as Tier[]).filter((t) => new RegExp(`\\b${t === "LOW" ? "low[- ]risk|low[- ]tier" : t.toLowerCase()}\\b`, "i").test(text));
  return {
    text: text.trim(), doc: "insurance_certificate", min_liability: amt.amount, currency: amt.currency,
    applies_to: { ...(categories.length ? { categories } : {}), ...(countries.length ? { countries } : {}), ...(tiers.length ? { tiers } : {}) },
  };
}

/** Guardrails on a proposed requirement. Code decides, whatever the AI said. */
export function validateRequirement(d: RequirementDraft, policy: Policy): { ok: true } | { ok: false; reason: string } {
  if (WEAKENING.test(d.text)) return { ok: false, reason: LOOSEN_REASON };
  if (d.doc !== "insurance_certificate") return { ok: false, reason: "Only certificate-of-insurance minimums are supported for now." };
  if (!(d.min_liability > 0)) return { ok: false, reason: "The minimum cover must be more than zero." };
  const cap = d.currency === "INR" ? 1e10 : 1e8;
  if (d.min_liability > cap) return { ok: false, reason: `${fmtMoney(d.min_liability, d.currency)} looks like a typo: no vendor would meet it. Check the amount.` };
  const bad = (d.applies_to.categories ?? []).filter((c) => !CATEGORIES.includes(c));
  if (bad.length) return { ok: false, reason: `Unknown vendor category: ${bad.join(", ")}.` };
  const a = d.applies_to;
  const scoped = !!(a.categories?.length || a.countries?.length || a.tiers?.length);
  if (!scoped && !/\b(all|every|any|each)\b/i.test(d.text))
    return { ok: false, reason: "Say which vendors this is for, e.g. “for IT vendors”, “for US vendors” or “for all vendors”." };
  const same = (x?: string[], y?: string[]) => JSON.stringify([...(x ?? [])].sort()) === JSON.stringify([...(y ?? [])].sort());
  const covered = (policy.requirements ?? []).find(
    (r) => r.currency === d.currency && r.min_liability >= d.min_liability && same(r.applies_to.categories, a.categories) && same(r.applies_to.countries, a.countries) && same(r.applies_to.tiers, a.tiers),
  );
  if (covered) return { ok: false, reason: `Already covered: ${covered.id} requires ${fmtMoney(covered.min_liability, covered.currency)} for ${describeScope(covered)}.` };
  return { ok: true };
}

export function summariseRequirement(d: RequirementDraft) {
  return `${describeScope(d as Requirement).replace(/^./, (c) => c.toUpperCase())} must send a certificate of insurance with at least ${fmtMoney(d.min_liability, d.currency)} general liability per occurrence`;
}

export function nextRequirementId(policy: Policy) {
  return `R${(policy.requirements ?? []).length + 1}`;
}
