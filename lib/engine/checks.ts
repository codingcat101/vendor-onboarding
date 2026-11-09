// Every check in the process. Each one is plain, deterministic code: the AI only
// supplies what it read from documents (ctx.docs). Each check lists the inputs it
// depends on (`deps`) so that a resubmission re-runs only what changed.
import {
  ACCOUNT_RE, CIN_RE, GST_STATE_CODES, clean, expectedPanTypes, validateGstin, validatePan, validateTaxIdForCountry,
} from "./ids";
import { lookupIfsc } from "./ifsc";
import { bestMatch, compareNames } from "./names";
import { HARD_CODES, Policy, requiredDocs } from "./policy";
import {
  CheckResult, DOC_LABEL, DocSlot, ExistingVendor, ExtractedDoc, Invite, Stage, Submission, Tier,
} from "./types";

export interface Ctx {
  sub: Submission;
  invite: Invite;
  tier: Tier;
  policy: Policy;
  docs: Partial<Record<DocSlot, ExtractedDoc>>;
  master: ExistingVendor[];
}

type Result = Omit<CheckResult, "id" | "stage" | "title">;

export interface CheckDef {
  id: string;
  stage: Stage;
  title: string;
  deps: string[];
  applies?: (ctx: Ctx) => boolean;
  run: (ctx: Ctx) => Result;
}

const pass = (message: string, evidence?: Result["evidence"]): Result => ({ outcome: "pass", message, evidence });
const skip = (message: string): Result => ({ outcome: "skip", message });
const warn = (message: string, evidence?: Result["evidence"]): Result => ({ outcome: "warn", message, evidence });
const fail = (
  severity: Result["severity"], code: string, message: string,
  extra: { vendor_message?: string; evidence?: Result["evidence"] } = {},
): Result => ({ outcome: "fail", severity, code, message, ...extra, hard: HARD_CODES.has(code) });

/** The AI could not read a key identifier. That's the AI's problem, not evidence against the vendor: a person checks by eye. */
const notRead = (what: string, doc: string): Result =>
  fail("needs_review", "DOC_FIELD_NOT_READ", `The AI could not read the ${what} on the ${doc}; a person should check it by eye`);

const isIndia = (ctx: Ctx) => ctx.sub.country === "IN";
const tail = (s: string, n = 4) => `…${s.slice(-n)}`;

/** A document is usable for cross-checks only if it was uploaded, readable, and the right type. */
function usableDoc(ctx: Ctx, slot: DocSlot): ExtractedDoc | null {
  const d = ctx.docs[slot];
  if (!d) return null;
  if (d.confidence < ctx.policy.min_doc_confidence) return null;
  const ok = d.doc_type === slot || ctx.policy.doc_substitutes.some((s) => s.slot === slot && s.accepts === d.doc_type);
  return ok ? d : null;
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------
const completeness: CheckDef[] = [
  {
    id: "required_fields",
    stage: "completeness",
    title: "All required fields filled",
    deps: ["form"],
    run: ({ sub }) => {
      const need: [string, unknown][] = [
        ["Legal name", sub.legal_name], ["Constitution", sub.constitution], ["Address", sub.address?.line1],
        ["City", sub.address?.city], ["State", sub.address?.state], ["PIN / postcode", sub.address?.pincode],
        ["Contact email", sub.contact?.email], ["Account holder name", sub.bank?.account_holder],
        ["Account number", sub.bank?.account_number], ["Bank name", sub.bank?.bank_name],
      ];
      if (sub.country === "IN") need.push(["GSTIN", sub.gstin], ["PAN", sub.pan], ["IFSC", sub.bank?.ifsc]);
      else need.push(["Tax ID", sub.tax_id]);
      const missing = need.filter(([, v]) => !String(v ?? "").trim()).map(([k]) => k);
      if (missing.length)
        return fail("vendor_fixable", "FIELD_MISSING", `Missing: ${missing.join(", ")}`, {
          vendor_message: `Please fill in: ${missing.join(", ")}.`,
        });
      return pass(`All ${need.length} required fields present`);
    },
  },
  {
    id: "required_documents",
    stage: "completeness",
    title: "Documents required for this tier uploaded",
    deps: ["form.documents", "invite", "policy", "form.constitution"],
    run: (ctx) => {
      const req = requiredDocs(ctx.tier, ctx.sub, ctx.policy);
      const missing = req.filter((d) => !ctx.sub.documents[d]);
      if (missing.length)
        return fail("vendor_fixable", "DOC_MISSING", `Missing for ${ctx.tier} tier: ${missing.map((d) => DOC_LABEL[d]).join(", ")}`, {
          vendor_message: `Please upload: ${missing.map((d) => DOC_LABEL[d]).join(", ")}.`,
          evidence: { required: req.map((d) => DOC_LABEL[d]).join(", ") },
        });
      return pass(`${req.length} of ${req.length} required documents uploaded (${ctx.tier} tier)`, {
        required: req.map((d) => DOC_LABEL[d]).join(", "),
      });
    },
  },
];

// ---------------------------------------------------------------------------
// Document check (one per slot) — is each upload what it claims to be, and readable?
// ---------------------------------------------------------------------------
const docSlots: DocSlot[] = ["gst_certificate", "pan_card", "cancelled_cheque", "incorporation_certificate"];
const DOC_TYPE_LABEL: Record<string, string> = {
  ...DOC_LABEL, invoice: "an invoice", bank_letter: "a bank letter", purchase_order: "a purchase order",
  aadhaar_card: "an Aadhaar card", other: "an unrelated document",
};

const documentChecks: CheckDef[] = docSlots.map((slot) => ({
  id: `doc_${slot}`,
  stage: "documents" as Stage,
  title: `${DOC_LABEL[slot]} is genuine type & readable`,
  deps: [`doc.${slot}`, "policy"],
  applies: (ctx) => !!ctx.sub.documents[slot],
  run: (ctx) => {
    const d = ctx.docs[slot];
    if (!d) return skip("Not uploaded");
    const conf = Math.round(d.confidence * 100);
    if (d.confidence < ctx.policy.min_doc_confidence)
      return fail("vendor_fixable", "DOC_UNREADABLE", `${DOC_LABEL[slot]} could not be read reliably (confidence ${conf}%)`, {
        vendor_message: `Your ${DOC_LABEL[slot]} is hard to read. Please upload a clearer scan or photo.`,
        evidence: { confidence: conf },
      });
    const substitute = ctx.policy.doc_substitutes.find((s) => s.slot === slot && s.accepts === d.doc_type);
    if (d.doc_type !== slot && !substitute) {
      const what = DOC_TYPE_LABEL[d.doc_type] ?? d.doc_type;
      return fail("vendor_fixable", "DOC_WRONG_TYPE", `Uploaded as ${DOC_LABEL[slot]}, but it is ${what}`, {
        vendor_message: `The file you uploaded as your ${DOC_LABEL[slot]} looks like ${what}. Please upload your ${DOC_LABEL[slot]}.`,
        evidence: { expected: DOC_LABEL[slot], found: what, confidence: conf },
      });
    }
    return pass(
      substitute
        ? `Accepted ${DOC_TYPE_LABEL[d.doc_type] ?? d.doc_type} in place of ${DOC_LABEL[slot]} (policy rule)`
        : `Recognised as ${DOC_LABEL[slot]} (${conf}% confidence)`,
      { confidence: conf, read_by: d.source },
    );
  },
}));

// ---------------------------------------------------------------------------
// Format check
// ---------------------------------------------------------------------------
const format: CheckDef[] = [
  {
    id: "gstin_format",
    stage: "format",
    title: "GSTIN format & check digit",
    deps: ["form.gstin"],
    applies: isIndia,
    run: ({ sub }) => {
      const r = validateGstin(sub.gstin);
      if (r.valid) return pass(`Valid GSTIN; state code ${r.stateCode} = ${r.state}`, { gstin: clean(sub.gstin) });
      const msg =
        r.reason === "checksum"
          ? `Check digit is wrong (should be '${r.expectedCheck}') — most likely a typo`
          : r.reason === "state_code" ? "First two digits are not a valid state code" : "Not in GSTIN format (15 characters: 29ABCDE1234F1Z5)";
      return fail("vendor_fixable", "GSTIN_INVALID", msg, {
        vendor_message: `Your GSTIN "${sub.gstin}" doesn't look right: ${msg.toLowerCase()}. Please re-check it against your GST certificate.`,
      });
    },
  },
  {
    id: "tax_id_country",
    stage: "format",
    title: "Tax ID format matches country",
    deps: ["form.tax_id", "form.country"],
    applies: (ctx) => !isIndia(ctx),
    run: ({ sub }) => {
      const r = validateTaxIdForCountry(sub.country, sub.tax_id);
      if (r.valid) return pass(`Tax ID format valid for ${sub.country}`);
      return fail("vendor_fixable", "TAX_ID_FORMAT", `Tax ID "${sub.tax_id}" is not a valid format for ${sub.country}; expected ${r.expected}`, {
        vendor_message: `The tax ID you entered doesn't match the format used in ${sub.country} (expected ${r.expected}). Please check it.`,
      });
    },
  },
  {
    id: "pan_format",
    stage: "format",
    title: "PAN format & holder type matches constitution",
    deps: ["form.pan", "form.constitution"],
    applies: isIndia,
    run: ({ sub }) => {
      const r = validatePan(sub.pan);
      if (!r.valid)
        return fail("vendor_fixable", "PAN_INVALID", `"${sub.pan}" is not a valid PAN format (ABCDE1234F)`, {
          vendor_message: `Your PAN "${sub.pan}" doesn't look right. Please re-check it.`,
        });
      const expected = expectedPanTypes(sub.constitution);
      if (expected && !expected.includes(r.holderType))
        return fail("needs_review", "PAN_TYPE_MISMATCH",
          `PAN is for a ${r.holderLabel}, but vendor declared "${sub.constitution}"`, {
            evidence: { pan_4th_char: r.holderType, declared: sub.constitution },
          });
      return pass(`Valid PAN; holder type ${r.holderLabel} matches "${sub.constitution}"`);
    },
  },
  {
    id: "ifsc_valid",
    stage: "format",
    title: "IFSC is a real branch of the stated bank",
    deps: ["form.bank"],
    applies: isIndia,
    run: ({ sub }) => {
      const r = lookupIfsc(sub.bank.ifsc);
      if (!r.found) {
        const why = r.reason === "format" ? "is not in IFSC format" : r.reason === "unknown_bank" ? "has an unknown bank code" : `is not a known ${r.bankName} branch`;
        return fail("vendor_fixable", "IFSC_INVALID", `IFSC ${sub.bank.ifsc} ${why}`, {
          vendor_message: `The IFSC code "${sub.bank.ifsc}" ${why}. Please copy it from your cheque book or bank statement.`,
        });
      }
      const stated = compareNames(sub.bank.bank_name, r.bankName);
      const statedNorm = sub.bank.bank_name.toUpperCase();
      const sameBank = stated.verdict !== "mismatch" || statedNorm.includes(r.bankName.toUpperCase().split(" ")[0]);
      if (!sameBank)
        return fail("vendor_fixable", "IFSC_BANK_MISMATCH", `IFSC belongs to ${r.bankName}, but bank name says "${sub.bank.bank_name}"`, {
          vendor_message: `Your IFSC code belongs to ${r.bankName}, but you entered "${sub.bank.bank_name}". Please check which is correct.`,
        });
      return pass(`${r.ifsc} is a valid ${r.bankName} branch (offline IFSC registry)`);
    },
  },
  {
    id: "account_format",
    stage: "format",
    title: "Bank account number format",
    deps: ["form.bank"],
    applies: isIndia,
    run: ({ sub }) =>
      ACCOUNT_RE.test(clean(sub.bank.account_number))
        ? pass(`Account number ${tail(sub.bank.account_number)} has valid length`)
        : fail("vendor_fixable", "ACCOUNT_INVALID", "Account number must be 9–18 digits", {
            vendor_message: "Your bank account number should be 9–18 digits. Please re-check it.",
          }),
  },
  {
    id: "cin_format",
    stage: "format",
    title: "Company Identification Number (CIN) format",
    deps: ["form.cin", "invite", "form.constitution"],
    applies: (ctx) => isIndia(ctx) && requiredDocs(ctx.tier, ctx.sub, ctx.policy).includes("incorporation_certificate"),
    run: ({ sub }) =>
      CIN_RE.test(clean(sub.cin))
        ? pass(`CIN ${sub.cin} is well-formed`)
        : fail("vendor_fixable", "CIN_INVALID", `CIN "${sub.cin ?? ""}" is missing or malformed`, {
            vendor_message: "Please enter your 21-character Company Identification Number (CIN) from your certificate of incorporation.",
          }),
  },
];

// ---------------------------------------------------------------------------
// Cross-reference — the subtle stuff
// ---------------------------------------------------------------------------
const crossRef: CheckDef[] = [
  {
    id: "gstin_pan",
    stage: "cross_reference",
    title: "PAN inside GSTIN matches PAN given",
    deps: ["form.gstin", "form.pan"],
    applies: isIndia,
    run: ({ sub }) => {
      const g = validateGstin(sub.gstin);
      if (!g.valid || !validatePan(sub.pan).valid) return skip("Needs a valid GSTIN and PAN first");
      if (g.pan !== clean(sub.pan))
        return fail("fraud", "GSTIN_PAN_MISMATCH",
          `GSTIN contains PAN ${g.pan}, but the vendor's PAN is ${clean(sub.pan)} — this GSTIN is registered to a different legal entity`, {
            evidence: { pan_in_gstin: g.pan, pan_given: clean(sub.pan) },
          });
      return pass(`Characters 3–12 of GSTIN = PAN ${g.pan}`);
    },
  },
  {
    id: "gstin_state",
    stage: "cross_reference",
    title: "GSTIN state matches address",
    deps: ["form.gstin", "form.address"],
    applies: isIndia,
    run: ({ sub }) => {
      const g = validateGstin(sub.gstin);
      if (!g.valid) return skip("Needs a valid GSTIN first");
      const addrState = sub.address.state.trim().toLowerCase();
      if (g.state.toLowerCase() !== addrState)
        return fail("needs_review", "GSTIN_STATE_MISMATCH",
          `GSTIN is registered in ${g.state} (code ${g.stateCode}), but the address is in ${sub.address.state}`, {
            evidence: { gstin_state: g.state, address_state: sub.address.state },
          });
      return pass(`State code ${g.stateCode} = ${g.state}, same as address`);
    },
  },
  {
    id: "gst_doc_matches",
    stage: "cross_reference",
    title: "GST certificate matches the form",
    deps: ["doc.gst_certificate", "form.gstin", "form.legal_name", "form.trade_name", "policy"],
    applies: (ctx) => !!ctx.sub.documents.gst_certificate,
    run: (ctx) => {
      const d = usableDoc(ctx, "gst_certificate");
      if (!d) return skip("Waiting for a valid GST certificate");
      const docG = clean(d.fields.gstin);
      if (!docG) return notRead("GSTIN", "GST certificate");
      if (docG !== clean(ctx.sub.gstin))
        return fail("needs_review", "DOC_GSTIN_MISMATCH", `Certificate shows GSTIN ${docG}, form says ${clean(ctx.sub.gstin)}`, {
          evidence: { on_document: docG, on_form: clean(ctx.sub.gstin) },
        });
      if (!d.fields.legal_name?.trim()) return warn("GSTIN matches; the AI could not read the name on the certificate, so it was not compared");
      const m = bestMatch(d.fields.legal_name, [ctx.sub.legal_name, ctx.sub.trade_name], ctx.policy.name_equivalences, ctx.sub.constitution);
      if (m.verdict === "mismatch")
        return fail("fraud", "DOC_NAME_MISMATCH",
          `GST certificate is in the name of "${d.fields.legal_name}", not "${ctx.sub.legal_name}"`, {
            evidence: { on_document: d.fields.legal_name, on_form: ctx.sub.legal_name, similarity: m.score },
          });
      if (m.verdict === "near")
        return fail("needs_review", "DOC_NAME_NEAR_MATCH", `Certificate name "${d.fields.legal_name}" is close to, but not the same as, "${m.against}"`, {
          evidence: { on_document: d.fields.legal_name, on_form: m.against, similarity: m.score },
        });
      return pass(`GSTIN and legal name on certificate match the form`);
    },
  },
  {
    id: "pan_doc_matches",
    stage: "cross_reference",
    title: "PAN card matches the form",
    deps: ["doc.pan_card", "form.pan", "form.legal_name", "policy"],
    applies: (ctx) => !!ctx.sub.documents.pan_card,
    run: (ctx) => {
      const d = usableDoc(ctx, "pan_card");
      if (!d) return skip("Waiting for a valid PAN card");
      if (!clean(d.fields.pan)) return notRead("PAN", "PAN card");
      if (clean(d.fields.pan) !== clean(ctx.sub.pan))
        return fail("needs_review", "DOC_PAN_MISMATCH", `PAN card shows ${d.fields.pan}, form says ${ctx.sub.pan}`, {
          evidence: { on_document: d.fields.pan, on_form: ctx.sub.pan ?? "" },
        });
      if (!d.fields.name?.trim()) return warn(`PAN ${ctx.sub.pan} matches; the AI could not read the name on the card, so it was not compared`);
      const m = compareNames(d.fields.name, ctx.sub.legal_name, ctx.policy.name_equivalences, ctx.sub.constitution);
      if (m.verdict === "mismatch")
        return fail("fraud", "DOC_NAME_MISMATCH", `PAN card is in the name of "${d.fields.name}", not "${ctx.sub.legal_name}"`);
      return pass(`PAN ${ctx.sub.pan} and name on card match`);
    },
  },
  {
    id: "cheque_matches",
    stage: "cross_reference",
    title: "Cancelled cheque matches bank details",
    deps: ["doc.cancelled_cheque", "form.bank", "policy"],
    applies: (ctx) => !!ctx.sub.documents.cancelled_cheque,
    run: (ctx) => {
      const d = usableDoc(ctx, "cancelled_cheque");
      if (!d) return skip("Waiting for a valid cancelled cheque");
      if (!clean(d.fields.account_number)) return notRead("account number", "cancelled cheque");
      const accDoc = clean(d.fields.account_number);
      const accForm = clean(ctx.sub.bank.account_number);
      const ifscDoc = clean(d.fields.ifsc);
      const ifscForm = clean(ctx.sub.bank.ifsc);
      if (accDoc !== accForm || (ifscDoc && ifscDoc !== ifscForm))
        return fail("vendor_fixable", "DOC_BANK_MISMATCH",
          `Cheque shows A/c ${tail(accDoc)} / ${ifscDoc}; form says A/c ${tail(accForm)} / ${ifscForm}`, {
            vendor_message: `The bank details on your cancelled cheque (A/c ${tail(accDoc)}, IFSC ${ifscDoc}) don't match what you entered (A/c ${tail(accForm)}, IFSC ${ifscForm}). Please correct the form or upload the cheque for the right account.`,
            evidence: { cheque_account: accDoc, form_account: accForm, cheque_ifsc: ifscDoc, form_ifsc: ifscForm ?? "" },
          });
      return pass(`Account ${tail(accForm)} and IFSC ${ifscForm} match the cheque`);
    },
  },
  {
    id: "bank_holder_name",
    stage: "cross_reference",
    title: "Bank account holder is the vendor",
    deps: ["form.bank", "form.legal_name", "form.trade_name", "form.constitution", "doc.cancelled_cheque", "policy"],
    run: (ctx) => {
      const holder = usableDoc(ctx, "cancelled_cheque")?.fields.account_holder || ctx.sub.bank.account_holder;
      const m = bestMatch(holder, [ctx.sub.legal_name, ctx.sub.trade_name], ctx.policy.name_equivalences, ctx.sub.constitution);
      const ev = { account_holder: holder, legal_name: ctx.sub.legal_name, trade_name: ctx.sub.trade_name ?? "", similarity: m.score };
      if (m.verdict === "mismatch")
        return fail("fraud", "BANK_NAME_MISMATCH",
          `Bank account is held by "${holder}", which doesn't match "${ctx.sub.legal_name}"${ctx.sub.trade_name ? ` or "${ctx.sub.trade_name}"` : ""} — payments could go to a third party`,
          { evidence: ev });
      if (m.verdict === "near")
        return fail("needs_review", "BANK_NAME_NEAR_MATCH",
          `Account holder "${holder}" is similar to "${m.against}" (${Math.round(m.score * 100)}% similar) but not the same`,
          { evidence: ev });
      return pass(
        m.ruleApplied
          ? `"${holder}" = "${m.against}" under taught rule (policy v${ctx.policy.version})`
          : `Account holder "${holder}" matches "${m.against}"`,
        ev,
      );
    },
  },
  {
    id: "coi_matches",
    stage: "cross_reference",
    title: "Incorporation certificate matches the form",
    deps: ["doc.incorporation_certificate", "form.cin", "form.pan", "form.legal_name", "policy"],
    applies: (ctx) => !!ctx.sub.documents.incorporation_certificate,
    run: (ctx) => {
      const d = usableDoc(ctx, "incorporation_certificate");
      if (!d) return skip("Waiting for a valid certificate of incorporation");
      const issues: string[] = [];
      if (d.fields.cin && clean(d.fields.cin) !== clean(ctx.sub.cin)) issues.push(`CIN ${d.fields.cin} ≠ ${ctx.sub.cin}`);
      if (d.fields.pan && clean(d.fields.pan) !== clean(ctx.sub.pan)) issues.push(`PAN ${d.fields.pan} ≠ ${ctx.sub.pan}`);
      if (!d.fields.legal_name?.trim()) return notRead("company name", "certificate of incorporation");
      const m = compareNames(d.fields.legal_name, ctx.sub.legal_name, ctx.policy.name_equivalences);
      if (m.verdict === "mismatch")
        return fail("fraud", "DOC_NAME_MISMATCH", `Certificate is for "${d.fields.legal_name}", not "${ctx.sub.legal_name}"`);
      if (issues.length) return fail("needs_review", "DOC_COI_MISMATCH", issues.join("; "));
      return pass("CIN, PAN and company name match the certificate");
    },
  },
];

// ---------------------------------------------------------------------------
// Fraud screen — against vendors already on file
// ---------------------------------------------------------------------------
const fraud: CheckDef[] = [
  {
    id: "bank_account_unique",
    stage: "fraud_screen",
    title: "Bank account not used by another vendor",
    deps: ["form.bank", "master", "form.legal_name"],
    run: ({ sub, master }) => {
      const acc = clean(sub.bank.account_number);
      const hit = master.find((v) => clean(v.bank.account_number) === acc && v.bank.ifsc.slice(0, 4) === clean(sub.bank.ifsc).slice(0, 4));
      if (hit && compareNames(hit.legal_name, sub.legal_name).verdict !== "match")
        return fail("fraud", "BANK_ACCOUNT_SHARED",
          `Account ${tail(acc)} at ${hit.bank.bank_name} already belongs to ${hit.legal_name} (${hit.vendor_id}). Two vendors paying into one account is a classic fake-vendor pattern.`,
          { evidence: { existing_vendor: `${hit.legal_name} (${hit.vendor_id})`, account: tail(acc) } });
      return pass(`Account ${tail(acc)} not found on any of ${master.length} existing vendors`);
    },
  },
  {
    id: "gstin_unique",
    stage: "fraud_screen",
    title: "GSTIN not registered to another vendor",
    deps: ["form.gstin", "master", "form.legal_name"],
    applies: isIndia,
    run: ({ sub, master }) => {
      const g = clean(sub.gstin);
      const hit = master.find((v) => clean(v.gstin) === g);
      if (!hit) return pass(`GSTIN not on file for any existing vendor`);
      if (compareNames(hit.legal_name, sub.legal_name).verdict === "match")
        return fail("needs_review", "DUPLICATE_VENDOR", `${hit.legal_name} is already an active vendor (${hit.vendor_id})`);
      return fail("fraud", "GSTIN_BELONGS_TO_OTHER_VENDOR",
        `GSTIN ${g} is already on file for ${hit.legal_name} (${hit.vendor_id}), not ${sub.legal_name}`,
        { evidence: { existing_vendor: `${hit.legal_name} (${hit.vendor_id})` } });
    },
  },
  {
    id: "pan_unique",
    stage: "fraud_screen",
    title: "PAN not registered to another vendor",
    deps: ["form.pan", "master", "form.legal_name"],
    applies: isIndia,
    run: ({ sub, master }) => {
      const p = clean(sub.pan);
      const hit = master.find((v) => clean(v.pan) === p);
      if (!hit) return pass(`PAN not on file for any existing vendor`);
      if (compareNames(hit.legal_name, sub.legal_name).verdict === "match")
        return fail("needs_review", "DUPLICATE_VENDOR", `${hit.legal_name} is already an active vendor (${hit.vendor_id})`);
      return fail("fraud", "PAN_BELONGS_TO_OTHER_VENDOR", `PAN ${p} is already on file for ${hit.legal_name} (${hit.vendor_id})`);
    },
  },
];

export const CHECKS: CheckDef[] = [...completeness, ...documentChecks, ...format, ...crossRef, ...fraud];

// keep tree-shakers / linters aware this is used for display
export const STATE_NAMES = Object.values(GST_STATE_CODES);
