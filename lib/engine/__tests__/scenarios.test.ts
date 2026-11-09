// Runs every test scenario end to end through the engine (document readings from ground truth)
// and checks the decision against expected.json.
import { describe, expect, it } from "vitest";
import { diffInputs, runOnboarding } from "../engine";
import { loadMaster, loadScenarios, truthReadings } from "../fixtures";
import { DEFAULT_POLICY, applyRule } from "../policy";
import type { DocSlot } from "../types";

const master = loadMaster();
const scenarios = loadScenarios();
const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));

function run(id: string, policy = DEFAULT_POLICY) {
  const s = byId[id];
  return runOnboarding({ sub: s.sub, invite: s.invite, docs: truthReadings(s), master, policy });
}

describe("first decision for every scenario matches expected.json", () => {
  for (const s of scenarios) {
    it(`${s.id}: ${s.title}`, () => {
      const r = run(s.id);
      const codes = r.decision.reasons.map((x) => x.code);
      expect(r.tier).toBe(s.expected.tier);
      expect(r.decision.status).toBe(s.expected.status);
      for (const code of s.expected.reasons) expect(codes).toContain(code);
    });
  }
});

describe("follow-up loop: incremental re-check (V03 wrong document)", () => {
  it("re-runs only the checks touched by the new document, then approves", () => {
    const s = byId.V03;
    const first = runOnboarding({ sub: s.sub, invite: s.invite, docs: truthReadings(s), master, policy: DEFAULT_POLICY });
    expect(first.decision.status).toBe("PENDING_VENDOR");
    expect(first.decision.vendor_actions[0].message).toMatch(/looks like an invoice/);

    const fixedSub = { ...s.sub, documents: { ...s.sub.documents, ...s.expected.fix_documents } };
    const fixedDocs = truthReadings(s, fixedSub.documents);
    const changed = diffInputs({ sub: s.sub, docs: truthReadings(s) }, { sub: fixedSub, docs: fixedDocs });
    const second = runOnboarding({ sub: fixedSub, invite: s.invite, docs: fixedDocs, master, policy: DEFAULT_POLICY, previous: first, changed });

    expect(second.decision.status).toBe("APPROVED");
    expect(second.rechecked).toEqual(expect.arrayContaining(["doc_gst_certificate", "gst_doc_matches"]));
    expect(second.rechecked).not.toContain("bank_account_unique");
    expect(second.rechecked).not.toContain("gstin_format");
    const carried = second.checks.filter((c) => c.carried_over).length;
    expect(carried).toBeGreaterThan(second.rechecked!.length);
  });
});

describe("international vendor (V09): tax ID format wrong for the country", () => {
  it("asks the UK vendor for a VAT number, accepts a bank letter, then approves after the fix", () => {
    const s = byId.V09;
    const first = run("V09");
    expect(first.decision.status).toBe("PENDING_VENDOR");
    expect(first.decision.vendor_actions[0].message).toMatch(/Indian GST number/);
    expect(first.checks.find((c) => c.id === "doc_cancelled_cheque")!.outcome).toBe("pass"); // bank letter accepted outside India
    expect(first.checks.find((c) => c.id === "intl_bank")!.outcome).toBe("pass"); // IBAN mod-97
    const fixed = { ...s.sub, ...(s.expected.fix_fields as object) };
    const docs = truthReadings(s);
    const changed = diffInputs({ sub: s.sub, docs }, { sub: fixed, docs });
    const second = runOnboarding({ sub: fixed, invite: s.invite, docs, master, policy: DEFAULT_POLICY, previous: first, changed });
    expect(second.decision.status).toBe("APPROVED");
    expect(second.rechecked).toContain("tax_id_country");
    expect(second.rechecked).not.toContain("doc_cancelled_cheque");
  });
});

describe("reviewer teaching (V04 → V05)", () => {
  const rule = { type: "name_equivalence" as const, phrases: ["TRADERS", "TRADING COMPANY"], constitutions: ["proprietor"] };
  const v2 = applyRule(DEFAULT_POLICY, rule, {
    at: "2026-11-11T10:00:00+05:30", by: "Reviewer", summary: "Traders = Trading Co. for proprietorships",
    reviewer_note: "For sole proprietors, 'Traders' and 'Trading Co' are the same business", source_case: "V04",
  });

  it("policy version increments and history records who/why", () => {
    expect(v2.version).toBe(2);
    expect(v2.history.at(-1)).toMatchObject({ version: 2, source_case: "V04" });
    expect(DEFAULT_POLICY.name_equivalences).toHaveLength(0); // original untouched
  });
  it("under v1 V05 needs a reviewer; under v2 it is approved automatically", () => {
    expect(run("V05").decision.status).toBe("PENDING_INTERNAL");
    const r = run("V05", v2);
    expect(r.decision.status).toBe("APPROVED");
    expect(r.checks.find((c) => c.id === "bank_holder_name")!.message).toMatch(/taught rule/);
  });
  it("a policy change re-runs only policy-dependent checks", () => {
    const s = byId.V04;
    const first = run("V04");
    const second = runOnboarding({ sub: s.sub, invite: s.invite, docs: truthReadings(s), master, policy: v2, previous: first, changed: ["policy"] });
    expect(second.decision.status).toBe("APPROVED");
    expect(second.rechecked).toContain("bank_holder_name");
    expect(second.rechecked).not.toContain("gstin_format");
  });
  it("GUARDRAIL: teaching cannot rescue the fraud cases", () => {
    expect(run("V06", v2).decision.status).toBe("REJECTED");
    expect(run("V07", v2).decision.status).toBe("REJECTED");
    expect(run("V06").checks.find((c) => c.code === "BANK_ACCOUNT_SHARED")!.hard).toBe(true);
  });
});

describe("tiering", () => {
  it("V08 missing cheque asks the vendor for exactly that document", () => {
    const r = run("V08");
    expect(r.decision.vendor_actions).toHaveLength(1);
    expect(r.decision.vendor_actions[0].message).toMatch(/Cancelled cheque/);
  });
  it("V02 strategic: incorporation certificate required and checked", () => {
    const r = run("V02");
    expect(r.checks.find((c) => c.id === "coi_matches")!.outcome).toBe("pass");
    expect(r.decision.reasons[0].code).toBe("STRATEGIC_SIGNOFF_REQUIRED");
  });
  it("a low-confidence reading asks for a clearer copy instead of guessing", () => {
    const s = byId.V01;
    const docs = truthReadings(s);
    docs.cancelled_cheque = { ...docs.cancelled_cheque!, confidence: 0.4 };
    const r = runOnboarding({ sub: s.sub, invite: s.invite, docs, master, policy: DEFAULT_POLICY });
    expect(r.decision.status).toBe("PENDING_VENDOR");
    expect(r.decision.reasons.map((x) => x.code)).toContain("DOC_UNREADABLE");
  });
  it("a field the AI could not read is never treated as a mismatch (no false fraud)", () => {
    const s = byId.V01;
    const docs = truthReadings(s);
    docs.pan_card = { ...docs.pan_card!, fields: { pan: docs.pan_card!.fields.pan } }; // name blank
    const r = runOnboarding({ sub: s.sub, invite: s.invite, docs, master, policy: DEFAULT_POLICY });
    expect(r.decision.status).toBe("APPROVED");
    expect(r.checks.find((c) => c.id === "pan_doc_matches")!.outcome).toBe("warn");
    docs.pan_card = { ...docs.pan_card!, fields: {} }; // PAN itself blank -> a person checks
    const r2 = runOnboarding({ sub: s.sub, invite: s.invite, docs, master, policy: DEFAULT_POLICY });
    expect(r2.decision.status).toBe("PENDING_INTERNAL");
    expect(r2.decision.reasons.map((x) => x.code)).toEqual(["DOC_FIELD_NOT_READ"]);
  });
  it("when the AI can't read a document at all, a person checks it; the vendor is not blamed", () => {
    const s = byId.V01;
    const docs = truthReadings(s);
    docs.cancelled_cheque = { ...docs.cancelled_cheque!, doc_type: "other", fields: {}, confidence: 0, error: "quota exceeded" };
    const r = runOnboarding({ sub: s.sub, invite: s.invite, docs, master, policy: DEFAULT_POLICY });
    expect(r.decision.status).toBe("PENDING_INTERNAL");
    expect(r.decision.reasons.map((x) => x.code)).toEqual(["DOC_NOT_READ_AI"]);
    expect(r.decision.vendor_actions).toHaveLength(0);
  });
  it("same vendor, higher spend → stricter tier and more documents", () => {
    const s = byId.V01;
    const r = runOnboarding({ sub: s.sub, invite: { ...s.invite, annual_spend_inr: 200_000 }, docs: truthReadings(s), master, policy: DEFAULT_POLICY });
    expect(r.tier).toBe("LOW");
    const slots: DocSlot[] = ["gst_certificate", "cancelled_cheque"];
    expect(r.checks.find((c) => c.id === "required_documents")!.evidence!.required).toBe(
      slots.map((x) => ({ gst_certificate: "GST registration certificate", cancelled_cheque: "Cancelled cheque" })[x as "gst_certificate"]).join(", "),
    );
  });
});
