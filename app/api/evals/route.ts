// Live evals for the governance page. Everything here is computed on request from the bundled
// samples and the AI readings recorded from real Gemini runs: nothing is a hard-coded score.
import { NextResponse } from "next/server";
import { WATCHLIST } from "@/lib/engine/checks";
import { runOnboarding } from "@/lib/engine/engine";
import { cachedReading } from "@/lib/engine/extract";
import { Scenario, loadMaster, loadScenarios, truthReadings } from "@/lib/engine/fixtures";
import { normaliseName } from "@/lib/engine/names";
import { DEFAULT_POLICY, applyRule } from "@/lib/engine/policy";
import { parseRequirementByRules, validateRequirement } from "@/lib/engine/requirements";
import { canTeach, proposeNameRule, validateRule } from "@/lib/engine/teach";
import type { DocSlot, ExtractedDoc, RunResult } from "@/lib/engine/types";

export const dynamic = "force-dynamic";
const WORD: Record<string, string> = { APPROVED: "Approved", REJECTED: "Rejected", PENDING_VENDOR: "Pending: vendor", PENDING_INTERNAL: "Pending: review" };
const AS_OF = "2026-11-10";
const ID_FIELDS = new Set(["gstin", "pan", "account_number", "ifsc", "cin", "tin"]);
const norm = (k: string, v = "") => (ID_FIELDS.has(k) ? v.toUpperCase().replace(/[^A-Z0-9]/g, "") : normaliseName(v));

function slotOf(s: Scenario, file: string): DocSlot {
  const all = { ...s.sub.documents, ...s.expected.fix_documents } as Record<string, string>;
  return (Object.entries(all).find(([, f]) => f === file)?.[0] ?? "gst_certificate") as DocSlot;
}

function aiDocs(s: Scenario, documents: Partial<Record<DocSlot, string>>) {
  const out: Partial<Record<DocSlot, ExtractedDoc>> = {};
  for (const [slot, file] of Object.entries(documents) as [DocSlot, string][]) {
    const r = cachedReading(s.id, slot, file);
    if (!r) return null;
    out[slot] = r;
  }
  return out;
}

export async function GET() {
  const master = loadMaster();
  const scenarios = loadScenarios();
  const run = (s: Scenario, sub = s.sub, docs = truthReadings(s, sub.documents), policy = DEFAULT_POLICY): RunResult =>
    runOnboarding({ sub, invite: s.invite, docs, master, policy, asOf: AS_OF });

  // 1. Decisions: every sample, first decision and (where there is one) the decision after the vendor's fix,
  //    using the AI's own readings, then compared with the expected outcome.
  const decisions: { id: string; title: string; step: string; expected: string; got: string; reasons_ok: boolean; ok: boolean }[] = [];
  for (const s of scenarios) {
    const docs = aiDocs(s, s.sub.documents);
    if (!docs) continue;
    const r = run(s, s.sub, docs);
    const codes = r.decision.reasons.map((x) => x.code);
    const reasonsOk = s.expected.reasons.every((c) => codes.includes(c));
    decisions.push({ id: s.id, title: s.title, step: "First decision", expected: s.expected.status, got: r.decision.status, reasons_ok: reasonsOk, ok: reasonsOk && r.decision.status === s.expected.status });
    const after = s.expected.after_fix as { status: string } | undefined;
    if (after) {
      const sub = { ...s.sub, ...(s.expected.fix_fields ?? {}), documents: { ...s.sub.documents, ...s.expected.fix_documents } };
      const fixed = aiDocs(s, sub.documents);
      if (!fixed) continue;
      const r2 = run(s, sub, fixed);
      decisions.push({ id: s.id, title: s.title, step: "After the vendor's fix", expected: after.status, got: r2.decision.status, reasons_ok: true, ok: r2.decision.status === after.status });
    }
  }

  // 2. Determinism: the same inputs give the same decision, run after run.
  let identical = 0;
  let repeats = 0;
  for (const s of scenarios) {
    const a = JSON.stringify(run(s).checks.map((c) => [c.id, c.outcome, c.code]));
    for (let i = 0; i < 4; i++) {
      repeats++;
      if (JSON.stringify(run(s).checks.map((c) => [c.id, c.outcome, c.code])) === a) identical++;
    }
  }

  // 3. Document reading accuracy, per document type, from the recorded AI readings vs the known truth.
  const byType: Record<string, { docs: number; type_ok: number; fields: number; correct: number; ms: number; conf: number; models: Set<string>; misses: string[] }> = {};
  for (const s of scenarios) {
    for (const [file, truth] of Object.entries(s.expected.document_truth)) {
      const r = cachedReading(s.id, slotOf(s, file), file) as (ExtractedDoc & { ms?: number; model?: string }) | null;
      if (!r) continue;
      const { doc_type, ...fields } = truth;
      const t = (byType[doc_type] ??= { docs: 0, type_ok: 0, fields: 0, correct: 0, ms: 0, conf: 0, models: new Set(), misses: [] });
      t.docs++;
      if (r.doc_type === doc_type) t.type_ok++;
      t.ms += r.ms ?? 0;
      t.conf += r.confidence;
      if (r.model) t.models.add(r.model);
      for (const [k, v] of Object.entries(fields)) {
        t.fields++;
        if (norm(k, r.fields[k]) === norm(k, v)) t.correct++;
        else t.misses.push(`${s.id} ${k}: read “${r.fields[k] ?? ""}”, truth “${v}”`);
      }
    }
  }
  const reading = Object.entries(byType)
    .map(([type, t]) => ({ type, docs: t.docs, type_ok: t.type_ok, fields: t.fields, correct: t.correct, avg_s: t.ms / t.docs / 1000, avg_conf: t.conf / t.docs, models: [...t.models], misses: t.misses }))
    .sort((a, b) => b.docs - a.docs);

  // 4. Guardrail probes: things a careless or malicious instruction might try. Each must be refused.
  const by = Object.fromEntries(scenarios.map((s) => [s.id, s]));
  const probes: { name: string; attempt: string; held: boolean; result: string }[] = [];
  const probe = (name: string, attempt: string, fn: () => { held: boolean; result: string }) => {
    try {
      probes.push({ name, attempt, ...fn() });
    } catch (e) {
      probes.push({ name, attempt, held: false, result: `Error: ${(e as Error).message}` });
    }
  };
  probe("Teach an exception on a fraud case", "Reviewer tries to turn “this vendor is fine” into a rule on V06 (bank account belongs to another vendor)", () => {
    const t = canTeach(run(by.V06).checks);
    return { held: !t.ok, result: t.ok ? "A rule was allowed" : t.reason };
  });
  probe("Teach away a sanctions hit", "Reviewer tries to teach a rule on V13 (possible watchlist match)", () => {
    const t = canTeach(run(by.V13).checks);
    return { held: !t.ok, result: t.ok ? "A rule was allowed" : t.reason };
  });
  probe("Rule that clears a sanctions hit indirectly", "A taught rule makes “Sabel” = “Sable”; is V13 still screened?", () => {
    const p = applyRule(DEFAULT_POLICY, { type: "name_equivalence", phrases: ["SABLE", "SABEL"] }, { at: "", by: "probe", summary: "" });
    const c = run(by.V13, by.V13.sub, undefined, p).checks.find((k) => k.id === "watchlist_screen")!;
    return { held: c.code === "POSSIBLE_WATCHLIST_MATCH", result: c.code === "POSSIBLE_WATCHLIST_MATCH" ? "Still flagged: the screen ignores taught rules" : "The hit was cleared by a rule" };
  });
  probe("Rule that names a specific vendor", "A rule “Sharma Traders” = “Sharma Trading Co”, with the vendor's own name in it", () => {
    const v = validateRule({ type: "name_equivalence", phrases: ["SHARMA TRADERS", "SHARMA TRADING COMPANY"] }, "SHARMA TRADERS", "SHARMA TRADING CO");
    const built = proposeNameRule("SHARMA TRADERS", "SHARMA TRADING CO", undefined);
    return { held: !v.ok, result: v.ok ? "The rule was accepted" : `${v.reason} The rule the system builds itself: ${built.ok ? built.summary : built.reason}` };
  });
  probe("Rule that makes a different company count as the vendor", "Teach “Harborline Logistics” = “Coastal Ledger Holdings” to pass V12's bank check", () => {
    const p = applyRule(DEFAULT_POLICY, { type: "name_equivalence", phrases: ["HARBORLINE LOGISTICS", "COASTAL LEDGER HOLDINGS"] }, { at: "", by: "probe", summary: "" });
    const c = run(by.V12, by.V12.sub, undefined, p).checks.find((k) => k.id === "bank_holder_name")!;
    return { held: c.code === "BANK_NAME_MISMATCH", result: c.code === "BANK_NAME_MISMATCH" ? "Still rejected: rules are never consulted for a clear mismatch" : "The rule passed the check" };
  });
  probe("Plain-English rule that loosens controls", "Procurement types “Skip the insurance check for small vendors under $1M”", () => {
    const d = parseRequirementByRules("Skip the insurance check for small vendors under $1M");
    const v = "error" in d ? { ok: false as const, reason: d.error } : validateRequirement(d, DEFAULT_POLICY);
    return { held: !v.ok, result: v.ok ? "The requirement was accepted" : v.reason };
  });
  probe("AI fails to read a field", "The GSTIN on V01's certificate comes back blank", () => {
    const docs = truthReadings(by.V01);
    docs.gst_certificate = { ...docs.gst_certificate!, fields: { ...docs.gst_certificate!.fields, gstin: "" } };
    const r = run(by.V01, by.V01.sub, docs);
    return { held: r.decision.status === "PENDING_INTERNAL", result: `Decision: ${WORD[r.decision.status]} (a person checks by eye, the vendor is not accused)` };
  });
  probe("AI service is down", "Every document on V01 fails to read", () => {
    const docs = truthReadings(by.V01);
    for (const k of Object.keys(docs) as DocSlot[]) docs[k] = { ...docs[k]!, error: "service unavailable", fields: {} };
    const r = run(by.V01, by.V01.sub, docs);
    return { held: r.decision.status === "PENDING_INTERNAL", result: `Decision: ${WORD[r.decision.status]} (goes to a person, not approved or rejected)` };
  });
  probe("Strategic vendor auto-approved", "V02 passes every check: does it skip sign-off?", () => {
    const r = run(by.V02);
    return { held: r.decision.status === "PENDING_INTERNAL", result: `Decision: ${WORD[r.decision.status]}, waiting for strategic sign-off` };
  });

  const decided = decisions.filter((d) => d.ok).length;
  const fieldsTotal = reading.reduce((a, r) => a + r.fields, 0);
  const fieldsOk = reading.reduce((a, r) => a + r.correct, 0);
  const docsTotal = reading.reduce((a, r) => a + r.docs, 0);
  return NextResponse.json({
    computed_at: new Date().toISOString(),
    summary: {
      decisions_ok: decided, decisions_total: decisions.length,
      determinism: { identical, repeats },
      docs_type_ok: reading.reduce((a, r) => a + r.type_ok, 0), docs_total: docsTotal,
      fields_ok: fieldsOk, fields_total: fieldsTotal,
      avg_read_s: reading.reduce((a, r) => a + r.avg_s * r.docs, 0) / Math.max(1, docsTotal),
      probes_held: probes.filter((p) => p.held).length, probes_total: probes.length,
      watchlist: { list: WATCHLIST.list, version: WATCHLIST.version, entries: WATCHLIST.entries.length },
    },
    decisions, reading, probes,
  });
}
