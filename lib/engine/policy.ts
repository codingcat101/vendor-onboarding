// The onboarding policy: tiers, required documents, and rules reviewers have taught.
// Policy is data, versioned, and every change is recorded. The engine reads it; it never edits it.
import type { DocSlot, Invite, Submission, Tier } from "./types";
import type { Equivalence } from "./names";

export interface PolicyChange {
  version: number;
  at: string;
  by: string;
  summary: string;
  reviewer_note?: string; // the plain-English explanation the rule came from
  source_case?: string;
}

/** Vendor categories a buyer can pick at invite time (also what plain-English requirements can target). */
export const CATEGORIES = [
  "Office stationery", "Packaging materials", "Housekeeping services", "Printing & signage", "Electrical supplies", "Hardware & tools",
  "Machined components", "Logistics", "IT services / data analytics", "Payroll & HR services", "Professional services",
];

export type Currency = "USD" | "INR" | "GBP";

/**
 * A requirement written by procurement in plain English, stored as structured data the code enforces.
 * v1 supports one kind: a certificate of insurance with a minimum general-liability cover.
 */
export interface Requirement {
  id: string;
  text: string; // the plain-English sentence it came from
  doc: "insurance_certificate";
  min_liability: number; // general liability, per occurrence
  currency: Currency;
  applies_to: { countries?: string[]; categories?: string[]; tiers?: Tier[] }; // empty = every vendor
  added_by: string;
}

export interface Policy {
  version: number;
  tiers: { low_max_inr: number; standard_max_inr: number };
  required_docs: Record<Tier, DocSlot[]>;
  /** Business-name equivalences taught by reviewers. */
  name_equivalences: Equivalence[];
  /** Accept another document type in place of the requested one, e.g. a bank letter for a cancelled cheque. */
  doc_substitutes: { slot: DocSlot; accepts: string }[];
  /** Minimum AI confidence to trust a document reading. Below this, ask for a clearer copy. */
  min_doc_confidence: number;
  /** Requirements procurement wrote in plain English (stored structured). */
  requirements: Requirement[];
  history: PolicyChange[];
}

export const DEFAULT_POLICY: Policy = {
  version: 1,
  tiers: { low_max_inr: 500_000, standard_max_inr: 10_000_000 },
  required_docs: {
    LOW: ["gst_certificate", "cancelled_cheque"],
    STANDARD: ["gst_certificate", "cancelled_cheque", "pan_card"],
    STRATEGIC: ["gst_certificate", "cancelled_cheque", "pan_card", "incorporation_certificate"],
  },
  name_equivalences: [],
  doc_substitutes: [],
  min_doc_confidence: 0.7,
  requirements: [
    {
      id: "R1", text: "All US vendors need a certificate of insurance with at least $1M general liability.", doc: "insurance_certificate",
      min_liability: 1_000_000, currency: "USD", applies_to: { countries: ["US"] }, added_by: "Initial setup",
    },
  ],
  history: [{ version: 1, at: "2026-11-01T09:00:00+05:30", by: "system", summary: "Initial policy" }],
};

export function computeTier(invite: Invite, policy: Policy): { tier: Tier; why: string } {
  const spend = invite.annual_spend_inr;
  const lakh = (n: number) => (n >= 10_000_000 ? `₹${(n / 10_000_000).toLocaleString("en-IN")} Cr` : `₹${(n / 100_000).toLocaleString("en-IN")}L`);
  if (invite.data_access) return { tier: "STRATEGIC", why: "Vendor will get access to company data or systems" };
  if (spend > policy.tiers.standard_max_inr)
    return { tier: "STRATEGIC", why: `Expected spend ${lakh(spend)} is above ${lakh(policy.tiers.standard_max_inr)}` };
  if (spend >= policy.tiers.low_max_inr)
    return { tier: "STANDARD", why: `Expected spend ${lakh(spend)} is between ${lakh(policy.tiers.low_max_inr)} and ${lakh(policy.tiers.standard_max_inr)}` };
  return { tier: "LOW", why: `Expected spend ${lakh(spend)} is below ${lakh(policy.tiers.low_max_inr)} and no data access` };
}

/** Requirements that apply to this vendor. */
export function requirementsFor(policy: Policy, sub: Pick<Submission, "country">, invite: Pick<Invite, "category"> | undefined, tier: Tier): Requirement[] {
  return (policy.requirements ?? []).filter((r) => {
    const a = r.applies_to;
    if (a.countries?.length && !a.countries.includes(sub.country)) return false;
    if (a.categories?.length && !(invite && a.categories.includes(invite.category))) return false;
    if (a.tiers?.length && !a.tiers.includes(tier)) return false;
    return true;
  });
}

export function fmtMoney(n: number, c: Currency) {
  if (c === "INR") return n >= 10_000_000 ? `₹${+(n / 10_000_000).toFixed(2)} Cr` : `₹${+(n / 100_000).toFixed(2)}L`;
  return `${c === "GBP" ? "£" : "$"}${n.toLocaleString("en-US")}`;
}

export function describeScope(r: Requirement) {
  const a = r.applies_to;
  const parts = [a.categories?.length ? a.categories.join(" / ") : "", a.countries?.length ? a.countries.map((c) => ({ US: "US", IN: "Indian", GB: "UK" })[c] ?? c).join(" / ") : "", a.tiers?.length ? `${a.tiers.map((t) => t.toLowerCase()).join(" / ")}-tier` : ""].filter(Boolean);
  return parts.length ? `${parts.join(", ")} vendors` : "all vendors";
}

export function requiredDocs(tier: Tier, sub: Submission, policy: Policy, invite?: Invite): DocSlot[] {
  const docs = [...policy.required_docs[tier]];
  // Plain-English requirements (e.g. "$1M liability cover for IT vendors") add a certificate of insurance.
  if (requirementsFor(policy, sub, invite, tier).length) docs.push("insurance_certificate");
  // Vendors that will touch our data or systems must show security evidence, whatever the spend.
  if (invite?.data_access) docs.push("security_certificate");
  if (sub.country !== "IN") {
    const abroad = docs.filter((d) => d !== "gst_certificate" && d !== "pan_card");
    // US vendors certify their legal name and taxpayer ID on IRS Form W-9 (needed for 1099 reporting).
    return sub.country === "US" ? ["w9_form", ...abroad] : abroad;
  }
  // Only companies have a certificate of incorporation.
  const isCompany = /company|limited liability partnership|llp/i.test(sub.constitution);
  return isCompany ? docs : docs.filter((d) => d !== "incorporation_certificate");
}

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------
/**
 * Reason codes no taught rule may ever relax. These are fraud / identity signals.
 * The engine marks these checks `hard`, and teach() refuses rules that would touch them.
 */
export const HARD_CODES = new Set([
  "BANK_ACCOUNT_SHARED",
  "GSTIN_PAN_MISMATCH",
  "GSTIN_BELONGS_TO_OTHER_VENDOR",
  "PAN_BELONGS_TO_OTHER_VENDOR",
  "DOC_NAME_MISMATCH",
  "BANK_NAME_MISMATCH",
  // Not fraud by itself (most hits are false positives), but no rule may ever clear it:
  // a named person decides every possible sanctions match and records why.
  "POSSIBLE_WATCHLIST_MATCH",
]);

/** Plain description of each fraud problem (what went wrong, not what the check looks for). */
export const HARD_LABEL: Record<string, string> = {
  BANK_ACCOUNT_SHARED: "bank account already belongs to another vendor",
  GSTIN_PAN_MISMATCH: "PAN inside the GSTIN is not the vendor's PAN",
  GSTIN_BELONGS_TO_OTHER_VENDOR: "GSTIN is on file for a different vendor",
  PAN_BELONGS_TO_OTHER_VENDOR: "PAN is on file for a different vendor",
  DOC_NAME_MISMATCH: "a document is in a clearly different name",
  BANK_NAME_MISMATCH: "bank account holder is a clearly different name",
  POSSIBLE_WATCHLIST_MATCH: "a name is close to an entry on the sanctions watchlist",
};

export function addRequirement(policy: Policy, req: Requirement, change: Omit<PolicyChange, "version">): Policy {
  const next: Policy = structuredClone(policy);
  next.version = policy.version + 1;
  next.requirements = [...(policy.requirements ?? []), req];
  next.history.push({ ...change, version: next.version });
  return next;
}

/** The only rule types a reviewer can teach. Anything else is refused. */
export type TaughtRule =
  | { type: "name_equivalence"; phrases: string[]; constitutions?: string[] }
  | { type: "doc_substitute"; slot: DocSlot; accepts: string };

export function applyRule(policy: Policy, rule: TaughtRule, change: Omit<PolicyChange, "version">): Policy {
  const next: Policy = structuredClone(policy);
  next.version = policy.version + 1;
  if (rule.type === "name_equivalence") next.name_equivalences.push({ phrases: rule.phrases, constitutions: rule.constitutions });
  if (rule.type === "doc_substitute") next.doc_substitutes.push({ slot: rule.slot, accepts: rule.accepts });
  next.history.push({ ...change, version: next.version });
  return next;
}
