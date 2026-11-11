// Every check in the process. Each one is plain, deterministic code: the AI only
// supplies what it read from documents (ctx.docs). Each check lists the inputs it
// depends on (`deps`) so that a resubmission re-runs only what changed.
import {
  ACCOUNT_RE, CIN_RE, GST_STATE_CODES, clean, expectedPanTypes, validateGstin, validatePan, validateTaxIdForCountry,
} from "./ids";
import { lookupIfsc } from "./ifsc";
import { validateAbaRouting, validateIban } from "./ids";
import { bestMatch, compareNames, normaliseName } from "./names";
import watchlistData from "../../data/watchlist.json";
import { HARD_CODES, Policy, requiredDocs } from "./policy";
import {
  ALL_DOC_SLOTS, COUNTRY_NAME, CheckResult, DOC_LABEL, DocSlot, docLabel, ExistingVendor, ExtractedDoc, Invite, Stage, Submission, Tier,
} from "./types";

export interface Ctx {
  sub: Submission;
  invite: Invite;
  tier: Tier;
  policy: Policy;
  docs: Partial<Record<DocSlot, ExtractedDoc>>;
  master: ExistingVendor[];
  /** "Today" for date checks (the app's clock, so the demo can skip ahead). */
  asOf: Date;
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

/** Documents accepted in place of the requested one: taught rules, plus bank letters outside India
 *  (cancelled cheques are an Indian convention). */
function substitutes(ctx: Ctx) {
  const base = ctx.policy.doc_substitutes;
  return ctx.sub.country === "IN" ? base : [...base, { slot: "cancelled_cheque" as DocSlot, accepts: "bank_letter" }];
}


/** A document is usable for cross-checks only if it was uploaded, readable, and the right type. */
function usableDoc(ctx: Ctx, slot: DocSlot): ExtractedDoc | null {
  const d = ctx.docs[slot];
  if (!d || d.error) return null;
  if (d.confidence < ctx.policy.min_doc_confidence) return null;
  const ok = d.doc_type === slot || substitutes(ctx).some((s) => s.slot === slot && s.accepts === d.doc_type);
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
      if (sub.country === "US") need.push(["Routing number", sub.bank?.ifsc]);
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
      const req = requiredDocs(ctx.tier, ctx.sub, ctx.policy, ctx.invite);
      const missing = req.filter((d) => !ctx.sub.documents[d]);
      const L = (d: DocSlot) => docLabel(d, ctx.sub.country);
      if (missing.length)
        return fail("vendor_fixable", "DOC_MISSING", `Missing for ${ctx.tier} tier: ${missing.map(L).join(", ")}`, {
          vendor_message: `Please upload: ${missing.map(L).join(", ")}.`,
          evidence: { required: req.map(L).join(", ") },
        });
      return pass(`${req.length} of ${req.length} required documents uploaded (${ctx.tier} tier)`, {
        required: req.map(L).join(", "),
      });
    },
  },
];

// ---------------------------------------------------------------------------
// Document check (one per slot) — is each upload what it claims to be, and readable?
// ---------------------------------------------------------------------------
const docSlots: DocSlot[] = ALL_DOC_SLOTS;
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
    // The AI couldn't read it at all (service down, quota). Not the vendor's fault: a person looks.
    if (d.error)
      return fail("needs_review", "DOC_NOT_READ_AI", `The AI could not read the ${docLabel(slot, ctx.sub.country)} right now, so a person should check it by eye`, {
        evidence: { reason: d.error.slice(0, 120) },
      });
    const conf = Math.round(d.confidence * 100);
    if (d.confidence < ctx.policy.min_doc_confidence)
      return fail("vendor_fixable", "DOC_UNREADABLE", `${DOC_LABEL[slot]} could not be read reliably (confidence ${conf}%)`, {
        vendor_message: `Your ${DOC_LABEL[slot]} is hard to read. Please upload a clearer scan or photo.`,
        evidence: { confidence: conf },
      });
    const substitute = substitutes(ctx).find((s) => s.slot === slot && s.accepts === d.doc_type);
    if (d.doc_type !== slot && !substitute) {
      const what = DOC_TYPE_LABEL[d.doc_type] ?? d.doc_type;
      return fail("vendor_fixable", "DOC_WRONG_TYPE", `Uploaded as ${DOC_LABEL[slot]}, but it is ${what}`, {
        vendor_message: `The file you uploaded as your ${DOC_LABEL[slot]} looks like ${what}. Please upload your ${DOC_LABEL[slot]}.`,
        evidence: { expected: DOC_LABEL[slot], found: what, confidence: conf },
      });
    }
    return pass(
      substitute
        ? `Accepted ${DOC_TYPE_LABEL[d.doc_type] ?? d.doc_type} in place of ${DOC_LABEL[slot]}${ctx.sub.country === "IN" ? " (policy rule)" : ""}`
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
      const where = COUNTRY_NAME[sub.country] ?? sub.country;
      if (r.valid) return pass(`Tax ID is a valid ${r.expected.split(",")[0]} for ${where}`);
      const looksIndian = validateGstin(sub.tax_id).valid;
      return fail("vendor_fixable", "TAX_ID_FORMAT",
        `Tax ID "${sub.tax_id}" is not valid for ${where}; expected ${r.expected}${looksIndian ? ". It is an Indian GSTIN" : ""}`, {
          vendor_message: `The tax ID you entered${looksIndian ? " is an Indian GST number, but" : ""} doesn't match the format used in ${where}. Please enter your ${r.expected}.`,
          evidence: { entered: sub.tax_id ?? "", country: where, expected: r.expected, looks_like_indian_gstin: looksIndian },
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
    id: "intl_bank",
    stage: "format",
    title: "Bank details valid for the country",
    deps: ["form.bank", "form.country"],
    applies: (ctx) => !isIndia(ctx),
    run: ({ sub }) => {
      if (sub.country === "GB") {
        return validateIban(sub.bank.account_number) && clean(sub.bank.account_number).startsWith("GB")
          ? pass(`UK IBAN ${tail(clean(sub.bank.account_number))} passes its mod-97 check`)
          : fail("vendor_fixable", "IBAN_INVALID", "Account number is not a valid UK IBAN (mod-97 check failed)", {
              vendor_message: "Please enter your full UK IBAN (it starts with GB and is 22 characters). It's printed on your bank letter or statement.",
            });
      }
      if (sub.country === "US") {
        return validateAbaRouting(sub.bank.ifsc ?? "")
          ? pass(`Routing number ${sub.bank.ifsc} passes the ABA checksum`)
          : fail("vendor_fixable", "ROUTING_INVALID", `Routing number "${sub.bank.ifsc}" fails the ABA checksum`, {
              vendor_message: "Your 9-digit bank routing number doesn't look right. Please copy it from your bank letter or a cheque.",
            });
      }
      return pass("No country-specific bank format check");
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
    applies: (ctx) => isIndia(ctx) && requiredDocs(ctx.tier, ctx.sub, ctx.policy, ctx.invite).includes("incorporation_certificate"),
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
      if (accDoc !== accForm || (ctx.sub.country === "IN" && ifscDoc && ifscDoc !== ifscForm))
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
      const ev = { account_holder: holder, compared_with: m.against, legal_name: ctx.sub.legal_name, trade_name: ctx.sub.trade_name ?? "", similarity: m.score };
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
    id: "w9_matches",
    stage: "cross_reference",
    title: "W-9 matches the form (name, EIN, signed)",
    deps: ["doc.w9_form", "form.tax_id", "form.legal_name", "form.trade_name", "form.constitution", "policy"],
    applies: (ctx) => !!ctx.sub.documents.w9_form,
    run: (ctx) => {
      const d = usableDoc(ctx, "w9_form");
      if (!d) return skip("Waiting for a valid W-9");
      const tinDoc = (d.fields.tin ?? "").replace(/\D/g, "");
      const tinForm = (ctx.sub.tax_id ?? "").replace(/\D/g, "");
      if (!tinDoc) return notRead("taxpayer ID", "W-9");
      if (!d.fields.legal_name?.trim()) return notRead("name on line 1", "W-9");
      const ev = { w9_name: d.fields.legal_name, w9_tin: tail(tinDoc), form_tax_id: tail(tinForm), entity_type: d.fields.entity_type ?? "", signed: d.fields.signature_date ?? "" };
      if (tinDoc !== tinForm)
        return fail("vendor_fixable", "W9_TIN_MISMATCH", `W-9 shows taxpayer ID ${tail(tinDoc)}, the form says ${tail(tinForm)}`, {
          vendor_message: `The EIN on your W-9 (ending ${tinDoc.slice(-4)}) doesn't match the tax ID you entered (ending ${tinForm.slice(-4)}). Please correct the form, or upload the W-9 for this business.`,
          evidence: ev,
        });
      const m = bestMatch(d.fields.legal_name, [ctx.sub.legal_name, ctx.sub.trade_name], ctx.policy.name_equivalences, ctx.sub.constitution);
      if (m.verdict === "mismatch")
        return fail("fraud", "DOC_NAME_MISMATCH", `W-9 is in the name of "${d.fields.legal_name}", not "${ctx.sub.legal_name}"`, {
          evidence: { on_document: d.fields.legal_name, on_form: ctx.sub.legal_name, similarity: m.score },
        });
      if (m.verdict === "near")
        return fail("needs_review", "DOC_NAME_NEAR_MATCH", `W-9 name "${d.fields.legal_name}" is close to, but not the same as, "${m.against}"`, {
          evidence: { on_document: d.fields.legal_name, on_form: m.against, similarity: m.score },
        });
      const signed = parseDate(d.fields.signature_date);
      if (!signed)
        return fail("vendor_fixable", "W9_UNSIGNED", "W-9 is not signed and dated", {
          vendor_message: "Your W-9 isn't signed and dated (Part II). Please sign it and upload it again.",
          evidence: ev,
        });
      const ageDays = Math.floor((ctx.asOf.getTime() - signed.getTime()) / DAY);
      if (ageDays > 3 * 365)
        return warn(`W-9 matches but was signed ${fmtDate(signed)}, over three years ago; ask for a fresh one at renewal`, ev);
      return pass(`W-9 name and EIN ${tail(tinDoc)} match the form; signed ${fmtDate(signed)}`, ev);
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
// Compliance evidence — vendors with data access
// ---------------------------------------------------------------------------
const DAY = 86_400_000;
const fmtDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // DD/MM/YYYY
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

const compliance: CheckDef[] = [
  {
    id: "security_cert_valid",
    stage: "cross_reference",
    title: "Security certificate is current and covers this vendor",
    deps: ["doc.security_certificate", "form.legal_name", "form.trade_name", "policy"],
    applies: (ctx) => !!ctx.sub.documents.security_certificate,
    run: (ctx) => {
      const d = usableDoc(ctx, "security_certificate");
      if (!d) return skip("Waiting for a valid security certificate");
      const std = d.fields.standard ?? "";
      if (!/27001|SOC\s*2/i.test(std))
        return fail("vendor_fixable", "SECURITY_CERT_WRONG_STANDARD", `Certificate is for "${std || "an unknown standard"}", not ISO 27001 or SOC 2`, {
          vendor_message: "Please upload an ISO/IEC 27001 certificate or a SOC 2 report for your organisation.",
          evidence: { standard: std },
        });
      const until = parseDate(d.fields.valid_until);
      if (!until) return notRead("expiry date", "security certificate");
      const days = Math.floor((until.getTime() - ctx.asOf.getTime()) / DAY);
      if (days < 0)
        return fail("vendor_fixable", "SECURITY_CERT_EXPIRED", `${std} certificate expired on ${fmtDate(until)} (${-days} days ago)`, {
          vendor_message: `Your ${std} certificate expired on ${fmtDate(until)}. Please upload the current certificate.`,
          evidence: { standard: std, valid_until: fmtDate(until), days_past: -days },
        });
      const m = bestMatch(d.fields.holder ?? "", [ctx.sub.legal_name, ctx.sub.trade_name], ctx.policy.name_equivalences, ctx.sub.constitution);
      if (m.verdict !== "match")
        return fail("needs_review", "SECURITY_CERT_NAME_MISMATCH",
          `Certificate is issued to "${d.fields.holder}", not "${ctx.sub.legal_name}". It may be a group or parent-company certificate; a person should confirm it covers this vendor`, {
            evidence: { holder: d.fields.holder ?? "", vendor: ctx.sub.legal_name, similarity: m.score },
          });
      if (days < 90)
        return warn(`${std} certificate is valid but expires on ${fmtDate(until)}, in ${days} days`, { valid_until: fmtDate(until), days_left: days });
      return pass(`${std} certificate issued to ${d.fields.holder}, valid until ${fmtDate(until)}`, { valid_until: fmtDate(until), days_left: days });
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

// ---------------------------------------------------------------------------
// Sanctions / watchlist screen. A possible hit never rejects on its own (most are false positives),
// and taught name rules are deliberately NOT applied here: a named person decides every hit.
// ---------------------------------------------------------------------------
export const WATCHLIST = watchlistData as { list: string; version: string; entries: { id: string; name: string; aliases: string[]; country: string; program: string }[] };

/** Every name this vendor could be paid or known under. */
export function screenedNames(ctx: Pick<Ctx, "sub" | "docs">) {
  const { sub, docs } = ctx;
  const raw = [
    sub.legal_name, sub.trade_name, sub.bank.account_holder,
    docs.cancelled_cheque?.fields.account_holder, docs.w9_form?.fields.legal_name, docs.w9_form?.fields.business_name,
  ];
  const seen = new Set<string>();
  return raw.filter((n): n is string => !!n?.trim()).filter((n) => {
    const k = normaliseName(n);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const screening: CheckDef[] = [
  {
    id: "watchlist_screen",
    stage: "fraud_screen",
    title: "Sanctions / watchlist screen",
    deps: ["form.legal_name", "form.trade_name", "form.bank", "doc.cancelled_cheque", "doc.w9_form"],
    run: (ctx) => {
      const names = screenedNames(ctx);
      let best: { name: string; entry: (typeof WATCHLIST.entries)[number]; listed: string; score: number } | null = null;
      for (const n of names)
        for (const e of WATCHLIST.entries)
          for (const listed of [e.name, ...e.aliases]) {
            const m = compareNames(n, listed); // no taught rules, on purpose
            if (m.verdict !== "mismatch" && (!best || m.score > best.score)) best = { name: n, entry: e, listed, score: m.score };
          }
      if (best) {
        const pct = Math.round(best.score * 100);
        return fail("needs_review", "POSSIBLE_WATCHLIST_MATCH",
          `"${best.name}" is ${pct}% similar to "${best.listed}" (${best.entry.id}, ${WATCHLIST.list}). Most hits are false positives: a person compares address, country and IDs before clearing it, and no rule can clear it`, {
            evidence: { screened_name: best.name, list_entry: best.listed, entry_id: best.entry.id, program: best.entry.program, similarity: best.score, list_version: WATCHLIST.version },
          });
      }
      return pass(`${names.length} name${names.length === 1 ? "" : "s"} screened against ${WATCHLIST.entries.length} entries on the ${WATCHLIST.list} (v${WATCHLIST.version}); no close match`, {
        names: names.join("; "), list_version: WATCHLIST.version,
      });
    },
  },
];

export const CHECKS: CheckDef[] = [...completeness, ...documentChecks, ...format, ...crossRef, ...compliance, ...fraud, ...screening];

// keep tree-shakers / linters aware this is used for display
export const STATE_NAMES = Object.values(GST_STATE_CODES);
