"use client";
// Procurement writes a requirement in plain English; the AI turns it into a structured rule;
// guardrails check it; a dry run shows which cases it would change; a person approves it.
import { useState } from "react";
import { REVIEWER, notifyAfterRun } from "@/lib/client/agent";
import { rerunWithPolicy } from "@/lib/client/pipeline";
import { Case, caseName, caseStatus, useStore } from "@/lib/client/store";
import { addRequirement, describeScope, fmtMoney, type Requirement } from "@/lib/engine/policy";
import { type RequirementDraft, nextRequirementId } from "@/lib/engine/requirements";
import { Section } from "./ui";

const EXAMPLES = ["Require $1M liability coverage for all IT vendors", "Logistics vendors need at least $2M general liability", "Skip the insurance check for small vendors"];
const WORD: Record<string, string> = { APPROVED: "Approved", REJECTED: "Rejected", PENDING_VENDOR: "Pending: vendor", PENDING_INTERNAL: "Pending: review", EXPIRED: "Closed" };
const OPEN = ["PENDING_VENDOR", "PENDING_INTERNAL"];

type Proposal = { ok: true; draft: RequirementDraft; summary: string; interpreted_by: string } | { ok: false; reason: string; interpreted_by?: string };
type Impact = { id: string; name: string; from: string; to: string; why: string };

export function RequirementsPanel() {
  const s = useStore();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [impact, setImpact] = useState<{ open: Impact[]; renewal: string[] } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const candidate = (d: RequirementDraft) => {
    const req: Requirement = { ...d, id: nextRequirementId(s.policy), added_by: REVIEWER };
    return { req, policy: addRequirement(s.policy, req, { at: s.now().toISOString(), by: REVIEWER, summary: `New requirement ${req.id}: ${d.text}` }) };
  };

  const runUnder = async (c: Case, policy: ReturnType<typeof candidate>["policy"]) => {
    const prev = c.runs.at(-1)!;
    const res = await fetch("/api/run", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sub: prev.inputs.sub, invite: c.invite, docs: prev.inputs.docs, policy, as_of: s.now().toISOString(), extra_master: s.approvedVendors().filter((v) => v.vendor_id !== c.id) }),
    });
    return (await res.json()) as { decision: { status: string; reasons: { code: string; message: string }[] } };
  };

  const interpret = async (t = text) => {
    setBusy(true);
    setProposal(null);
    setImpact(null);
    setDone(null);
    const r = await fetch("/api/requirement", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: t, policy: s.policy }) });
    const p = (await r.json()) as Proposal;
    setProposal(p);
    if (p.ok) {
      // Dry run: checks only, no AI calls, nothing saved.
      const { policy } = candidate(p.draft);
      const open: Impact[] = [];
      const renewal: string[] = [];
      for (const c of s.cases.filter((x) => x.runs.length && !x.final)) {
        const st = caseStatus(c);
        const j = await runUnder(c, policy);
        const newReason = j.decision.reasons.find((x) => !c.runs.at(-1)!.decision.reasons.some((y) => y.code === x.code));
        if (OPEN.includes(st) && (j.decision.status !== st || newReason)) open.push({ id: c.id, name: caseName(c), from: st, to: j.decision.status, why: newReason?.message ?? "" });
        if (st === "APPROVED" && j.decision.status !== "APPROVED") renewal.push(caseName(c));
      }
      setImpact({ open, renewal });
    }
    setBusy(false);
  };

  const approve = async () => {
    if (!proposal?.ok) return;
    setBusy(true);
    const { req, policy } = candidate(proposal.draft);
    s.setPolicy(policy);
    const at = s.now().toISOString();
    let changed = 0;
    for (const c of s.cases.filter((x) => x.runs.length && !x.final && OPEN.includes(caseStatus(x)))) {
      const r = await rerunWithPolicy(c, policy, s.approvedVendors(), at);
      if (!r) continue;
      const before = c.runs.at(-1)!.decision;
      s.updateCase(c.id, (old) => ({ ...old, runs: [...old.runs, r] }));
      const added = r.decision.reasons.some((x) => !before.reasons.some((y) => y.code === x.code));
      if (r.decision.status !== before.status || added) {
        changed++;
        s.addEvent(c.id, { actor: "Process", kind: "decision", text: `Re-checked under policy v${policy.version} (new requirement ${req.id}: “${req.text}”). Now: ${WORD[r.decision.status] ?? r.decision.status}.` });
        await notifyAfterRun(s, { ...c }, r);
      }
    }
    setDone(`Added ${req.id}. Policy is now v${policy.version}. ${changed ? `${changed} open case${changed === 1 ? "" : "s"} re-checked and the vendor${changed === 1 ? "" : "s"} asked for what's missing.` : "No open cases changed."}`);
    setProposal(null);
    setImpact(null);
    setText("");
    setBusy(false);
  };

  return (
    <Section title="Requirements, in plain English" className="lg:col-span-2" aside={<span className="text-[13px] text-ink-3">You define the rules; the process follows them</span>}>
      <ul className="grid gap-2 text-[14px]">
        {(s.policy.requirements ?? []).map((r) => (
          <li key={r.id} className="grid gap-x-3 sm:grid-cols-[40px_1fr]">
            <span className="font-mono text-[13px] font-semibold text-ink-3">{r.id}</span>
            <span>
              “{r.text}”
              <span className="block text-[13px] text-ink-2">
                Enforced as: certificate of insurance, general liability ≥ {fmtMoney(r.min_liability, r.currency)} per occurrence, for {describeScope(r)}. Added by {r.added_by}.
              </span>
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-5 border-t border-rule pt-4">
        <label className="block">
          <span className="label">Add a requirement</span>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input className="field flex-1" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Require $1M liability coverage for all IT vendors" onKeyDown={(e) => e.key === "Enter" && text.trim() && !busy && interpret()} />
            <button className="btn" disabled={!text.trim() || busy} onClick={() => interpret()}>{busy && !proposal ? "Reading…" : "Interpret"}</button>
          </div>
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button key={e} className="rounded-full border border-rule bg-sheet px-2.5 py-1 text-[12px] text-ink-2 hover:border-ink-3" onClick={() => { setText(e); interpret(e); }} disabled={busy}>
              {e}
            </button>
          ))}
        </div>

        {proposal && !proposal.ok && (
          <div className="mt-4 rounded-md border border-reject/40 bg-reject-bg px-3 py-2 text-[14px]">
            <p className="font-semibold text-reject">Not added</p>
            <p>{proposal.reason}</p>
            {proposal.interpreted_by && <p className="mt-1 text-[12px] text-ink-3">Read by {proposal.interpreted_by}</p>}
          </div>
        )}

        {proposal?.ok && (
          <div className="mt-4 rounded-md border border-review/40 bg-review-bg px-3 py-3 text-[14px]">
            <p className="font-semibold text-review">Understood as</p>
            <p>{proposal.summary}.</p>
            <p className="mt-1 text-[12px] text-ink-3">
              Read by {proposal.interpreted_by}; checked by code: it only adds a check, the amount is plausible, the categories exist.
            </p>
            <p className="mt-3 font-semibold">If you approve it</p>
            {!impact ? (
              <p className="text-ink-2">Working out which cases it would change…</p>
            ) : (
              <ul className="mt-1 list-disc pl-5">
                {impact.open.map((i) => (
                  <li key={i.id}>{i.name}: {WORD[i.from]} → <b>{WORD[i.to] ?? i.to}</b>{i.why ? ` (${i.why})` : ""}</li>
                ))}
                {impact.open.length === 0 && <li>No open cases change.</li>}
                {impact.renewal.length > 0 && <li>{impact.renewal.length} approved vendor{impact.renewal.length === 1 ? "" : "s"} ({impact.renewal.join(", ")}) would be asked at renewal; approvals already made are not undone.</li>}
              </ul>
            )}
            <div className="mt-3 flex gap-2">
              <button className="btn" disabled={busy || !impact} onClick={approve}>Approve: policy v{s.policy.version + 1}</button>
              <button className="btn btn-quiet" disabled={busy} onClick={() => { setProposal(null); setImpact(null); }}>Discard</button>
            </div>
          </div>
        )}
        {done && <p className="mt-3 text-[14px] font-semibold text-approve">{done}</p>}
      </div>
    </Section>
  );
}
