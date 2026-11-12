"use client";
// Agent governance: what each agent may do on its own, how we know it is doing it right (live evals),
// and what the agents actually did in this visitor's sandbox.
import Link from "next/link";
import { useEffect, useState } from "react";
import { caseStatus, useStore } from "@/lib/client/store";
import { HARD_CODES, HARD_LABEL } from "@/lib/engine/policy";
import { Section, fmtTime } from "@/components/ui";

type Evals = {
  computed_at: string;
  summary: {
    decisions_ok: number; decisions_total: number; determinism: { identical: number; repeats: number };
    docs_type_ok: number; docs_total: number; fields_ok: number; fields_total: number; avg_read_s: number;
    probes_held: number; probes_total: number; watchlist: { list: string; version: string; entries: number };
  };
  decisions: { id: string; title: string; step: string; expected: string; got: string; ok: boolean }[];
  reading: { type: string; docs: number; type_ok: number; fields: number; correct: number; avg_s: number; avg_conf: number; models: string[]; misses: string[] }[];
  probes: { name: string; attempt: string; held: boolean; result: string }[];
};

const TYPE_LABEL: Record<string, string> = {
  gst_certificate: "GST certificate", pan_card: "PAN card", cancelled_cheque: "Cancelled cheque", bank_letter: "Bank letter (UK, US)",
  incorporation_certificate: "Certificate of incorporation", security_certificate: "ISO 27001 certificate", invoice: "Invoice (wrong document)", w9_form: "IRS Form W-9", insurance_certificate: "Certificate of insurance",
};
const STATUS_WORD: Record<string, string> = { APPROVED: "Approved", REJECTED: "Rejected", PENDING_VENDOR: "Pending: vendor", PENDING_INTERNAL: "Pending: review" };

/** Agent operating procedure: who may do what, alone or not, and the limit that applies. */
const AOP: { action: string; who: string; mode: "alone" | "person" | "never"; limit: string }[] = [
  { action: "Read an uploaded document", who: "AI reader (Gemini, 3-model fallback)", mode: "alone", limit: "Sees only the document, never the form. Returns fields and a confidence; below 70% the vendor is asked for a clearer copy, and if the AI is down a person reads it." },
  { action: "Decide approve / send back / review / reject", who: "Decision rules (code)", mode: "alone", limit: "Deterministic: same input, same decision. Every check is logged with its evidence and the policy version." },
  { action: "Ask the vendor to fix something", who: "Follow-up agent", mode: "alone", limit: "Only for problems the vendor can fix. Writes to the vendor contact on file, never names a fraud check. AI drafts, template if the AI is unavailable." },
  { action: "Chase a silent vendor", who: "Follow-up agent", mode: "alone", limit: "Reminder on day 2, escalation to the requester on day 5, closes on day 10. Cannot approve or reject." },
  { action: "Approve a low or standard-risk vendor", who: "Decision rules", mode: "alone", limit: "Only when every check passes, including the sanctions screen." },
  { action: "Approve a strategic vendor (over ₹1 Cr, or data access)", who: "A named reviewer", mode: "person", limit: "Always a person, even when every check passes." },
  { action: "Clear a possible sanctions match", who: "A named reviewer", mode: "person", limit: "Reason required, saved to the audit trail. Never cleared by a taught rule; the screen ignores taught rules." },
  { action: "Change the rules", who: "Reviewer approves, AI proposes", mode: "person", limit: "AI reads the reviewer's note; code builds the rule; guardrails check it; a dry run shows which cases it would change; the policy version goes up." },
  { action: "Create the vendor in the ERP", who: "Finance", mode: "person", limit: "v1 exports a ready vendor record (CSV / JSON). v2: direct write via the ERP's API after approval, with the same audit trail." },
  { action: "Override a fraud check", who: "Nobody", mode: "never", limit: "Shared bank account, borrowed GSTIN or PAN, documents or bank account in another name. Not by hand, not by a rule." },
];
const MODE = {
  alone: { label: "On its own", color: "var(--approve)", bg: "var(--approve-bg)" },
  person: { label: "Needs a person", color: "var(--review)", bg: "var(--review-bg)" },
  never: { label: "Nobody can", color: "var(--reject)", bg: "var(--reject-bg)" },
};

function Tile({ value, label, note }: { value: string; label: string; note?: string }) {
  return (
    <div className="relative min-w-0 overflow-hidden rounded-xl border border-rule bg-sheet px-4 pb-3 pt-4">
      <span className="grad-bar absolute inset-x-0 top-0 h-1" aria-hidden />
      <div className="text-[30px] font-extrabold leading-none tracking-tight">{value}</div>
      <div className="mt-1.5 text-[14px] font-semibold">{label}</div>
      {note && <div className="text-[13px] text-ink-2">{note}</div>}
    </div>
  );
}

const pct = (a: number, b: number) => (b ? `${Math.round((1000 * a) / b) / 10}%` : "—");

export default function GovernancePage() {
  const s = useStore();
  const [ev, setEv] = useState<Evals | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/evals").then((r) => r.json()).then(setEv).catch((e) => setErr(String(e)));
  }, []);

  // What the agents did in this visitor's sandbox.
  const readings = s.cases.flatMap((c) => c.runs.flatMap((r) => Object.values(r.inputs.docs))).filter(Boolean);
  const uniqueReads = [...new Map(readings.map((r) => [`${r!.file}:${r!.ms}:${r!.source}`, r!])).values()];
  const live = uniqueReads.filter((r) => r.source === "ai" && !r.error).length;
  const recorded = uniqueReads.filter((r) => r.source === "cache").length;
  const failed = uniqueReads.filter((r) => !!r.error).length;
  const decided = s.cases.filter((c) => c.runs.length);
  const auto = decided.filter((c) => !c.final && ["APPROVED", "REJECTED", "PENDING_VENDOR", "EXPIRED"].includes(caseStatus(c))).length;
  const byPerson = decided.filter((c) => c.final);
  const withReason = byPerson.filter((c) => c.final!.note.trim().length >= 5).length;
  const agentMsgs = s.outbox.filter((m) => m.kind !== "approved" && m.kind !== "rejected");
  const aiDrafted = s.outbox.filter((m) => m.drafted_by?.startsWith("AI")).length;
  const agentActions = s.cases.flatMap((c) => c.events.filter((e) => e.actor === "Follow-up agent").map((e) => ({ ...e, case: c })));
  const ruleChanges = s.policy.history.filter((h) => h.by !== "system");

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-[26px] font-extrabold leading-tight tracking-tight">Agent governance</h1>
        <p className="mt-1 max-w-[860px] text-[15px] text-ink-2">
          What each agent may do on its own, how we know it is doing it right, and what it actually did. The scores below are computed now from the {ev ? ev.summary.docs_total : "sample"} recorded
          AI readings of the sample documents; nothing on this page is typed in by hand.
        </p>
      </div>

      <Section title="Operating procedure: who may do what" aside={<Link className="text-[13px] underline" href="/policy">Rules in force: v{s.policy.version}</Link>}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[14px]">
            <thead>
              <tr className="text-left text-[12px] uppercase tracking-wide text-ink-3">
                <th className="py-1.5 pr-3 font-semibold">Action</th><th className="pr-3 font-semibold">Done by</th><th className="pr-3 font-semibold">Alone?</th><th className="font-semibold">Limit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule align-top">
              {AOP.map((a) => (
                <tr key={a.action}>
                  <td className="py-2 pr-3 font-semibold">{a.action}</td>
                  <td className="py-2 pr-3 text-ink-2">{a.who}</td>
                  <td className="py-2 pr-3">
                    <span className="whitespace-nowrap rounded px-1.5 py-0.5 text-[12px] font-semibold" style={{ color: MODE[a.mode].color, background: MODE[a.mode].bg }}>{MODE[a.mode].label}</span>
                  </td>
                  <td className="py-2 text-ink-2">{a.limit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[13px] text-ink-3">
          Checks no rule can relax: {[...HARD_CODES].map((c) => HARD_LABEL[c]).join("; ")}.
        </p>
      </Section>

      {err && <p className="text-reject">Could not load the evals: {err}</p>}
      {!ev && !err && <p className="text-ink-3">Running the evals…</p>}
      {ev && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile value={`${ev.summary.decisions_ok}/${ev.summary.decisions_total}`} label="Decisions correct" note="Every sample, first decision and after the fix, from the AI's own readings" />
            <Tile value={pct(ev.summary.fields_ok, ev.summary.fields_total)} label="Document fields read correctly" note={`${ev.summary.fields_ok} of ${ev.summary.fields_total}; document type right on ${ev.summary.docs_type_ok} of ${ev.summary.docs_total}`} />
            <Tile value={`${ev.summary.probes_held}/${ev.summary.probes_total}`} label="Guardrail probes held" note="Attempts to teach, bypass or trick the rules" />
            <Tile value={`${ev.summary.determinism.identical}/${ev.summary.determinism.repeats}`} label="Repeat runs identical" note="Same input, same checks, same decision" />
          </div>

          <Section title="Reading accuracy by document type" aside={<span className="text-[13px] text-ink-3">avg {ev.summary.avg_read_s.toFixed(1)} s per document</span>}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-[14px]">
                <thead>
                  <tr className="text-left text-[12px] uppercase tracking-wide text-ink-3">
                    <th className="py-1.5 pr-3 font-semibold">Document</th><th className="pr-3 font-semibold">Identified</th><th className="pr-3 font-semibold">Fields right</th><th className="pr-3 font-semibold">Avg confidence</th><th className="font-semibold">Misses</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule align-top">
                  {ev.reading.map((r) => (
                    <tr key={r.type}>
                      <td className="py-2 pr-3 font-semibold">{TYPE_LABEL[r.type] ?? r.type}</td>
                      <td className="py-2 pr-3">{r.type_ok}/{r.docs}</td>
                      <td className="py-2 pr-3">{r.correct}/{r.fields} <span className="text-ink-3">({pct(r.correct, r.fields)})</span></td>
                      <td className="py-2 pr-3">{Math.round(r.avg_conf * 100)}%</td>
                      <td className="py-2 text-[13px] text-ink-2">{r.misses.length ? r.misses.join("; ") + ". Handled: a field the AI can't read goes to a person." : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="Guardrail probes">
              <ul className="grid gap-2.5 text-[14px]">
                {ev.probes.map((p) => (
                  <li key={p.name} className="grid grid-cols-[22px_1fr] gap-x-2">
                    <span className="font-bold" style={{ color: p.held ? "var(--approve)" : "var(--reject)" }}>{p.held ? "✓" : "✕"}</span>
                    <span>
                      <b>{p.name}.</b> <span className="text-ink-2">{p.attempt}</span>
                      <span className="block text-[13px] text-ink-3">{p.result}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
            <Section title="Decisions on every sample">
              <table className="w-full text-[14px]">
                <tbody className="divide-y divide-rule">
                  {ev.decisions.map((d) => (
                    <tr key={d.id + d.step}>
                      <td className="py-1.5 pr-2 font-mono text-[13px]">{d.id}</td>
                      <td className="py-1.5 pr-2 text-ink-2">{d.step}</td>
                      <td className="py-1.5 pr-2">{STATUS_WORD[d.got] ?? d.got}</td>
                      <td className="py-1.5 text-right font-bold" style={{ color: d.ok ? "var(--approve)" : "var(--reject)" }}>{d.ok ? "✓" : `✕ expected ${STATUS_WORD[d.expected]}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          </div>
        </>
      )}

      <Section title="What the agents did in your sandbox" aside={<span className="text-[13px] text-ink-3">{decided.length} submitted case{decided.length === 1 ? "" : "s"}</span>}>
        {decided.length === 0 ? (
          <p className="text-[14px] text-ink-2">Nothing yet. Go to <Link className="underline" href="/">Cases</Link> and run the samples; this fills in as the agents work.</p>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-[14px]">
              <dt>Cases decided with no person involved</dt><dd className="font-semibold">{auto} of {decided.length}</dd>
              <dt>Cases a person decided</dt><dd className="font-semibold">{byPerson.length} ({withReason} with a written reason)</dd>
              <dt>Documents read by the AI live</dt><dd className="font-semibold">{live}</dd>
              <dt>Documents from recorded AI readings</dt><dd className="font-semibold">{recorded}</dd>
              <dt>Documents the AI could not read (sent to a person)</dt><dd className="font-semibold">{failed}</dd>
              <dt>Messages sent by the follow-up agent</dt><dd className="font-semibold">{agentMsgs.length} ({aiDrafted} drafted by AI, rest from templates)</dd>
              <dt>Rule changes</dt><dd className="font-semibold">{ruleChanges.length}{ruleChanges.length ? `, each approved by ${[...new Set(ruleChanges.map((h) => h.by))].join(", ")}` : ""}</dd>
            </dl>
            <div>
              <p className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-ink-3">Latest agent actions</p>
              {agentActions.length === 0 ? (
                <p className="text-[14px] text-ink-2">None yet.</p>
              ) : (
                <ul className="grid gap-1.5 text-[14px]">
                  {agentActions.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6).map((e, i) => (
                    <li key={i}>
                      <span className="text-ink-3">{fmtTime(e.at)} · </span>
                      <Link className="underline" href={`/cases/${e.case.id}`}>{e.case.invite.vendor_name}</Link>: {e.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Section>

      {ev && (
        <p className="text-[13px] text-ink-3">
          Computed {fmtTime(ev.computed_at)}. Sanctions screen uses the {ev.summary.watchlist.list} (v{ev.summary.watchlist.version}, {ev.summary.watchlist.entries} fictional entries), a stand-in for the OFAC SDN and
          Consolidated Screening lists. The repository also runs 64 automated tests on every change.
        </p>
      )}
    </div>
  );
}
