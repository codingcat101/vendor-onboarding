import { describe, expect, it } from "vitest";
import { runOnboarding } from "../engine";
import { loadMaster, loadScenarios, truthReadings } from "../fixtures";
import { DEFAULT_POLICY, applyRule } from "../policy";
import { canTeach, interpretNoteByRules, namesFromCheck, proposeNameRule, validateRule } from "../teach";

const master = loadMaster();
const byId = Object.fromEntries(loadScenarios().map((s) => [s.id, s]));
const run = (id: string) => runOnboarding({ sub: byId[id].sub, invite: byId[id].invite, docs: truthReadings(byId[id]), master, policy: DEFAULT_POLICY });

describe("teaching from a reviewer's decision", () => {
  it("builds the rule from the words that differ (V04)", () => {
    const r = run("V04");
    const t = canTeach(r.checks);
    expect(t.ok).toBe(true);
    const [a, b] = namesFromCheck((t as { check: typeof r.checks[0] }).check)!;
    const p = proposeNameRule(a, b, ["proprietor"]);
    expect(p).toMatchObject({ ok: true, rule: { type: "name_equivalence", phrases: ["TRADERS", "TRADING COMPANY"], constitutions: ["proprietor"] } });
  });

  it("the taught rule then approves V05 on its own", () => {
    const r = run("V04");
    const [a, b] = namesFromCheck(r.checks.find((c) => c.code === "BANK_NAME_NEAR_MATCH")!)!;
    const p = proposeNameRule(a, b, ["proprietor"]);
    if (!p.ok) throw new Error(p.reason);
    const v2 = applyRule(DEFAULT_POLICY, p.rule, { at: "", by: "r", summary: p.summary });
    const s = byId.V05;
    expect(runOnboarding({ sub: s.sub, invite: s.invite, docs: truthReadings(s), master, policy: v2 }).decision.status).toBe("APPROVED");
  });

  it("GUARDRAIL: fraud cases cannot be taught", () => {
    expect(canTeach(run("V06").checks)).toMatchObject({ ok: false });
    expect(canTeach(run("V07").checks)).toMatchObject({ ok: false });
  });

  it("GUARDRAIL: a rule may not contain the vendor's own name", () => {
    const v = validateRule({ type: "name_equivalence", phrases: ["SHARMA TRADERS", "SHARMA TRADING COMPANY"] }, "SHARMA TRADERS", "Sharma Trading Co.");
    expect(v).toMatchObject({ ok: false });
  });

  it("GUARDRAIL: a rule cannot make unrelated names match", () => {
    expect(proposeNameRule("ACME HOLDINGS", "Sharma Trading Co.", undefined)).toMatchObject({ ok: false });
  });

  it("reads the reviewer's note: one-off vs general, and scope", () => {
    expect(interpretNoteByRules("I called them, this time it's fine", "Proprietorship").generalise).toBe(false);
    expect(interpretNoteByRules("Sole proprietors often bank as 'Traders'", "Proprietorship")).toMatchObject({ generalise: true, scope: ["proprietor"] });
    expect(interpretNoteByRules("True for any business", "Proprietorship").scope).toBeUndefined();
  });
});
