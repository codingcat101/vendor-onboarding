// Core types for the vendor onboarding process.

export type Tier = "LOW" | "STANDARD" | "STRATEGIC";
export type Status = "APPROVED" | "PENDING_VENDOR" | "PENDING_INTERNAL" | "REJECTED";

/** How serious a failed check is. Decides the final status. */
export type Severity =
  | "vendor_fixable" // vendor can fix it: missing/wrong document, typo        -> PENDING_VENDOR
  | "needs_review" //   ambiguous, a person should judge                        -> PENDING_INTERNAL
  | "fraud"; //         integrity / identity problem                           -> REJECTED

export type Outcome = "pass" | "fail" | "warn" | "skip";

export type DocSlot = "gst_certificate" | "pan_card" | "cancelled_cheque" | "incorporation_certificate";

export const DOC_LABEL: Record<DocSlot, string> = {
  gst_certificate: "GST registration certificate",
  pan_card: "PAN card",
  cancelled_cheque: "Cancelled cheque",
  incorporation_certificate: "Certificate of incorporation",
};

export interface Invite {
  buyer: string;
  category: string;
  annual_spend_inr: number;
  data_access: boolean;
}

export interface Submission {
  legal_name: string;
  trade_name?: string;
  constitution: string; // "Private Limited Company" | "Limited Liability Partnership" | "Partnership Firm" | "Proprietorship" | ...
  country: string; // ISO-2: IN, US, GB
  address: { line1: string; city: string; state: string; pincode: string };
  gstin?: string; // India tax ID
  tax_id?: string; // non-India tax ID (EIN, VAT)
  pan?: string;
  cin?: string;
  contact: { name: string; email: string; phone: string };
  bank: { account_holder: string; account_number: string; ifsc?: string; bank_name: string };
  /** slot -> file reference */
  documents: Partial<Record<DocSlot, string>>;
}

/** What the AI read from one uploaded document. */
export interface ExtractedDoc {
  slot: DocSlot;
  file: string;
  doc_type: string; // what the document actually is (may differ from slot!)
  fields: Record<string, string>;
  confidence: number; // 0..1
  source: "ai" | "cache" | "ground_truth";
}

export interface ExistingVendor {
  vendor_id: string;
  legal_name: string;
  gstin: string;
  pan: string;
  state: string;
  bank: { account_number: string; ifsc: string; bank_name: string };
  status: string;
}

export interface CheckResult {
  id: string;
  stage: Stage;
  title: string;
  outcome: Outcome;
  severity?: Severity; // only when outcome === "fail"
  code?: string; // machine reason code, e.g. GSTIN_PAN_MISMATCH
  message: string; // plain-English explanation (shown to reviewer)
  vendor_message?: string; // what to ask the vendor to do (only for vendor_fixable)
  evidence?: Record<string, string | number | boolean | null>;
  carried_over?: boolean; // result reused from previous run (incremental re-check)
  hard?: boolean; // fraud guardrail: no taught rule can override this check
}

export type Stage = "intake" | "completeness" | "documents" | "format" | "cross_reference" | "fraud_screen" | "decision";

export const STAGES: { id: Stage; label: string }[] = [
  { id: "intake", label: "Intake" },
  { id: "completeness", label: "Completeness" },
  { id: "documents", label: "Document check" },
  { id: "format", label: "Format check" },
  { id: "cross_reference", label: "Cross-reference" },
  { id: "fraud_screen", label: "Fraud screen" },
  { id: "decision", label: "Decision" },
];

export interface Decision {
  status: Status;
  reasons: { code: string; severity: Severity | "signoff"; message: string }[];
  summary: string;
  vendor_actions: { code: string; message: string }[];
}

export interface RunResult {
  tier: Tier;
  policy_version: number;
  checks: CheckResult[];
  decision: Decision;
  rechecked?: string[]; // ids of checks that actually ran (incremental runs)
}
