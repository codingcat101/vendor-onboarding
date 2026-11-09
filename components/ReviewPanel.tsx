"use client";
import { useState } from "react";
import { REVIEWER, notifyAfterRun } from "@/lib/client/agent";
import { rerunWithPolicy } from "@/lib/client/pipeline";
import { Case, CaseRun, caseName, caseStatus, useStore } from "@/lib/client/store";
import { HARD_LABEL, applyRule, type TaughtRule } from "@/lib/engine/policy";
import { canTeach } from "@/lib/engine/teach";
import { Section } from "./ui";

type TeachResponse =
  | { ok: true; rule: TaughtRule; summary: string; why: string; interpreted_by: string; names: [string, string] }
  | { ok: false; reason: string; one_off?: boolean; interpreted_by?: string };

export function ReviewPanel({ c, run }: { c: Case; run: CaseRun }) {
  const s = useStore();
  const [note, setNote] = useState("");
  const [teach, setTeach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<TeachResponse | null>(null);
  const [preview, setPreview] = useState<{ id: string; name: string; to: string }[] | null>(null);
  const [applied, setApplied] = useState<number | null>(null);

  const teachable = canTeach(run.checks);
  const signoffOnly = run.decision.reasons.every((r) => r.code === "STRATEGIC_SIGNOFF_REQUIRED");
  const decided = !!c.final;

  const decide = async (status: "APPROVED" | "REJECTED") => {
    setBusy(true);
    const at = s.now().toISOString();
    s.updateCase(c.id, (old) => ({ ...old, final: { status, by: REVIEWER, note, at } }));
    s.addEvent(c.id, { actor: REVIEWER, kind: "review", text: `${status === "APPROVED" ? (signoffOnly ? "Signed off" : "Approved") : "Rejected"}. Reason: “${note}”` });
    await notifyAfterRun(s, c, { ...run, decision: { ...run.decision, status } });
    if (status === "APPROVED" && teach && teachable.ok) {
      const r = await fetch("/api/teach", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ checks: run.checks, note, constitution: c.sub?.constitution ?? "" }),
      });
      const p = (await r.json()) as TeachResponse;
      setProposal(p);
      if (p.ok) await dryRun(p.rule);
    }
    setBusy(false);
  };

  // Which other waiting cases would this rule resolve? Checks only, no AI calls.
  const dryRun = async (rule: TaughtRule) => {
    const candidate = applyRule(s.policy, rule, { at: "", by: REVIEWER, summary: "" });
    const others = s.cases.filter((x) => x.id !== c.id && caseStatus(x) === "PENDING_INTERNAL" && x.runs.length);
    const out: { id: string; name: string; to: string }[] = [];
    for (const o of others) {
      const prev = o.runs.at(-1)!;
      const res = await fetch("/api/run", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sub: prev.inputs.sub, invite: o.invite, docs: prev.inputs.docs, policy: candidate, extra_master: s.approvedVendors().filter((v) => v.vendor_id !== o.id) }),
      });
      const j = await res.json();
      if (j.decision.status !== "PENDING_INTERNAL") out.push({ id: o.id, name: caseName(o), to: j.decision.status });
    }
    setPreview(out);
  };

  const addRule = async () => {
    if (!proposal?.ok) return;
    setBusy(true);
    const at = s.now().toISOString();
    const next = applyRule(s.policy, proposal.rule, { at, by: REVIEWER, summary: proposal.summary, reviewer_note: note, source_case: c.id });
    s.setPolicy(next);
    s.addEvent(c.id, { actor: REVIEWER, kind: "policy", text: `Turned this decision into a rule. Policy is now v${next.version}: ${proposal.summary}` });
    let n = 0;
    for (const o of s.cases.filter((x) => x.id !== c.id && caseStatus(x) === "PENDING_INTERNAL")) {
      const r = await rerunWithPolicy(o, next, s.approvedVendors(), at);
      if (!r) continue;
      s.updateCase(o.id, (old) => ({ ...old, runs: [...old.runs, r] }));
      if (r.decision.status !== "PENDING_INTERNAL") {
        n++;
        s.addEvent(o.id, { actor: "Process", kind: "decision", text: `Re-checked under policy v${next.version} (rule taught on ${c.id}). Now: ${r.decision.status === "APPROVED" ? "approved automatically" : r.decision.status.toLowerCase()}. Re-ran ${r.rechecked?.length} checks.` });
        await notifyAfterRun(s, { ...o }, r);
      }
    }
    setApplied(n);
    setBusy(false);
  };

  if (decided && !proposal)
    return (
      <Section title="Reviewer decision">
        <p className="text-[14px]">
          <b>{c.final!.by}</b> {c.final!.status === "APPROVED" ? "approved" : "rejected"} this vendor: “{c.final!.note}”
        </p>
      </Section>
    );

  return (
    <Section title={signoffOnly ? "Pending: sign-off needed" : "Pending: a reviewer decides"} aside={<span className="text-[13px] text-ink-3">Reviewing as {REVIEWER}</span>}>
      {!decided && (
        <>
          <ul className="mb-3 list-disc pl-5 text-[14px]">
            {run.decision.reasons.map((r) => (
              <li key={r.code}>{r.message}</li>
            ))}
          </ul>
          <label className="block">
            <span className="label">Why? This is saved to the audit trail{teachable.ok ? " and used to suggest a rule" : ""}.</span>
            <textarea
              className="field min-h-[72px]"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={teachable.ok ? "e.g. Sole proprietors often bank as “Traders” while registered as “Trading Co.”. Same business." : "e.g. Checked the contract and data-processing terms."}
            />
          </label>
          {teachable.ok && (
            <label className="mt-2 flex items-center gap-2 text-[14px]">
              <input type="checkbox" checked={teach} onChange={(e) => setTeach(e.target.checked)} />
              Suggest a rule so similar vendors don&apos;t need a person next time
            </label>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="btn" disabled={busy || note.trim().length < 5} onClick={() => decide("APPROVED")}>
              {signoffOnly ? "Sign off and approve" : "Approve"}
            </button>
            <button className="btn btn-quiet" disabled={busy || note.trim().length < 5} onClick={() => decide("REJECTED")}>
              Reject
            </button>
            {busy && <span className="self-center text-[13px] text-ink-3">Working…</span>}
          </div>
        </>
      )}

      {proposal && (
        <div className="mt-1 rounded-md border border-review/40 bg-review-bg px-4 py-3 text-[14px]">
          {proposal.ok ? (
            <>
              <p className="font-semibold text-review">Suggested rule</p>
              <p className="mt-0.5 text-[15px]">{proposal.summary}</p>
              <p className="mt-1 text-[13px] text-ink-2">
                Your note was read by {proposal.interpreted_by}: {proposal.why} The rule itself is built from the two names on this case and checked against
                the guardrails: no vendor-specific words, and it can only settle names that were already close.
              </p>
              {preview && (
                <p className="mt-2">
                  {preview.length
                    ? `It would also resolve ${preview.length} waiting case${preview.length > 1 ? "s" : ""}: ${preview.map((p) => `${p.name} (${p.id})`).join(", ")}.`
                    : "No other waiting cases are affected right now."}
                </p>
              )}
              {applied === null ? (
                <div className="mt-3 flex gap-2">
                  <button className="btn" disabled={busy} onClick={addRule}>
                    Add rule (policy v{s.policy.version + 1})
                  </button>
                  <button className="btn btn-quiet" disabled={busy} onClick={() => setProposal(null)}>
                    Not now
                  </button>
                </div>
              ) : (
                <p className="mt-2 font-semibold text-approve">
                  Rule added. Policy is v{s.policy.version}. {applied} waiting case{applied === 1 ? " was" : "s were"} re-checked and resolved.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="font-semibold">No rule suggested</p>
              <p className="mt-0.5">{proposal.reason}</p>
              {proposal.interpreted_by && <p className="mt-1 text-[13px] text-ink-2">Note read by {proposal.interpreted_by}.</p>}
            </>
          )}
        </div>
      )}
    </Section>
  );
}

/** On a rejected case: show that the fraud checks can't be overridden or taught. */
export function GuardrailPanel({ c, run }: { c: Case; run: CaseRun }) {
  const [msg, setMsg] = useState<string | null>(null);
  const t = canTeach(run.checks);
  const hard = run.checks.filter((k) => k.hard && k.outcome === "fail");
  if (!hard.length) return null;
  return (
    <Section title="Can a reviewer override this?">
      <p className="text-[14px]">
        No. This case failed {hard.length === 1 ? "a fraud check" : `${hard.length} fraud checks`}: {[...new Set(hard.map((h) => HARD_LABEL[h.code!] ?? h.title))].join("; ")}. Those can&apos;t be
        approved by hand or relaxed by a taught rule. The right next step is a call to the vendor using contact details from an independent source, not the ones on this form.
      </p>
      <button
        className="btn btn-quiet mt-3 !py-1 text-[13px]"
        onClick={async () => {
          const r = await fetch("/api/teach", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ checks: run.checks, note: "This vendor is fine, allow it", constitution: c.sub?.constitution ?? "" }),
          });
          const j = await r.json();
          setMsg(j.ok ? "Unexpected: a rule was proposed." : j.reason);
        }}
      >
        Try to teach an exception anyway
      </button>
      {msg && <p className="mt-2 rounded border border-reject/40 bg-reject-bg px-3 py-2 text-[14px]">Refused: {msg}</p>}
      {!t.ok && !msg && null}
    </Section>
  );
}
