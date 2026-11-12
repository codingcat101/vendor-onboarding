// Insurance minimums and plain-English requirements.
import { describe, expect, it } from "vitest";
import { runOnboarding } from "../engine";
import { loadMaster, loadScenarios, truthReadings } from "../fixtures";
import { DEFAULT_POLICY, addRequirement, type Policy } from "../policy";
import { parseAmount, parseRequirementByRules, validateRequirement, type RequirementDraft } from "../requirements";

const master = loadMaster();
const byId = Object.fromEntries(loadScenarios().map((s) => [s.id, s]));
const AS_OF = "2026-11-10";
function run(id: string, policy: Policy = DEFAULT_POLICY, fixed = false) {
  const s = byId[id];
  const sub = fixed ? { ...s.sub, documents: { ...s.sub.documents, ...s.expected.fix_documents } } : s.sub;
  return runOnboarding({ sub, invite: s.invite, docs: truthReadings(s, sub.documents), master, policy, asOf: AS_OF });
}
const withReq = (d: RequirementDraft) => addRequirement(DEFAULT_POLICY, { ...d, id: "R2", added_by: "test" }, { at: "", by: "test", summary: "" });

describe("certificate of insurance", () => {
  it("V14: $500K cover is below the $1M US minimum; the vendor is asked for an updated certificate, not rejected", () => {
    const r = run("V14");
    expect(r.decision.status).toBe("PENDING_VENDOR");
    const msg = r.decision.vendor_actions.map((a) => a.message).join(" ");
    expect(msg).toMatch(/\$500,000/);
    expect(msg).toMatch(/\$1,000,000/);
    expect(run("V14", DEFAULT_POLICY, true).decision.status).toBe("APPROVED");
  });

  it("an expired policy goes back to the vendor", () => {
    const s = byId.V11;
    const docs = truthReadings(s);
    docs.insurance_certificate = { ...docs.insurance_certificate!, fields: { ...docs.insurance_certificate!.fields, valid_until: "2026-10-01" } };
    const r = runOnboarding({ sub: s.sub, invite: s.invite, docs, master, policy: DEFAULT_POLICY, asOf: AS_OF });
    expect(r.decision.reasons.map((x) => x.code)).toContain("INSURANCE_EXPIRED");
  });

  it("a certificate for a different company is a fraud signal", () => {
    const s = byId.V11;
    const docs = truthReadings(s);
    docs.insurance_certificate = { ...docs.insurance_certificate!, fields: { ...docs.insurance_certificate!.fields, insured: "Coastal Ledger Holdings LLC" } };
    const r = runOnboarding({ sub: s.sub, invite: s.invite, docs, master, policy: DEFAULT_POLICY, asOf: AS_OF });
    expect(r.decision.status).toBe("REJECTED");
  });
});

describe("plain-English requirements", () => {
  it("reads amounts the way people write them", () => {
    expect(parseAmount("$1M")).toEqual({ amount: 1_000_000, currency: "USD" });
    expect(parseAmount("at least $2,000,000 cover")).toEqual({ amount: 2_000_000, currency: "USD" });
    expect(parseAmount("₹1 crore")).toEqual({ amount: 10_000_000, currency: "INR" });
    expect(parseAmount("Rs 50 lakh")).toEqual({ amount: 5_000_000, currency: "INR" });
    expect(parseAmount("1.5 million dollars")).toEqual({ amount: 1_500_000, currency: "USD" });
  });

  it("“Require $1M liability coverage for all IT vendors” becomes a structured rule", () => {
    const d = parseRequirementByRules("Require $1M liability coverage for all IT vendors") as RequirementDraft;
    expect(d.min_liability).toBe(1_000_000);
    expect(d.currency).toBe("USD");
    expect(d.applies_to.categories).toEqual(["IT services / data analytics"]);
    expect(validateRequirement(d, DEFAULT_POLICY).ok).toBe(true);
  });

  it("guardrails: can't loosen controls, must say who it's for, no duplicates, no absurd amounts", () => {
    const loosen = { ...(parseRequirementByRules("Skip the insurance check for small vendors under $1M") as RequirementDraft) };
    expect(validateRequirement(loosen, DEFAULT_POLICY).ok).toBe(false);
    const noScope = parseRequirementByRules("Vendors need $1M liability insurance") as RequirementDraft;
    expect(validateRequirement(noScope, DEFAULT_POLICY).ok).toBe(false);
    const dup = parseRequirementByRules("US vendors need $1M liability insurance") as RequirementDraft;
    expect(validateRequirement(dup, DEFAULT_POLICY).ok).toBe(false);
    const huge = parseRequirementByRules("All vendors need $5000M liability insurance") as RequirementDraft;
    expect(validateRequirement(huge, DEFAULT_POLICY).ok).toBe(false);
    expect("error" in parseRequirementByRules("Approve all stationery vendors automatically")).toBe(true);
  });

  it("a new IT requirement sends an Indian IT vendor back for a certificate; the strictest minimum wins", () => {
    const it$1m = withReq(parseRequirementByRules("Require $1M liability coverage for all IT vendors") as RequirementDraft);
    const nimbus = run("V02", it$1m);
    expect(nimbus.decision.status).toBe("PENDING_VENDOR");
    expect(nimbus.decision.vendor_actions.map((a) => a.message).join(" ")).toMatch(/Certificate of insurance/);
    // Pinecrest (US, IT) fixed its cover to $1M; a $2M IT requirement makes it short again.
    const it$2m = withReq(parseRequirementByRules("IT vendors need at least $2M general liability") as RequirementDraft);
    expect(run("V14", it$2m, true).decision.reasons.map((x) => x.code)).toContain("INSURANCE_COVERAGE_LOW");
    // Vendors outside the scope are untouched.
    expect(run("V01", it$2m).decision.status).toBe("APPROVED");
  });
});
