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

export function requiredDocs(tier: Tier, sub: Submission, policy: Policy, invite?: Invite): DocSlot[] {
  const docs = [...policy.required_docs[tier]];
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
