"use client";
import Link from "next/link";
import { daysWaiting, nextFollowUp } from "@/lib/client/agent";
import { Case, caseName, caseStatus, useStore } from "@/lib/client/store";
import { STATUS_META, Section } from "@/components/ui";

const REASON_LABEL: Record<string, string> = {
  DOC_WRONG_TYPE: "Wrong document uploaded",
  DOC_MISSING: "Document missing",
  DOC_UNREADABLE: "Document unreadable",
  DOC_FIELD_NOT_READ: "AI couldn't read a field",
  BANK_NAME_NEAR_MATCH: "Bank name near-match",
  DOC_NAME_NEAR_MATCH: "Document name near-match",
  BANK_ACCOUNT_SHARED: "Bank account shared",
  GSTIN_PAN_MISMATCH: "GSTIN under another PAN",
  GSTIN_STATE_MISMATCH: "GSTIN state ≠ address",
  GSTIN_BELONGS_TO_OTHER_VENDOR: "GSTIN on another vendor",
  DOC_NAME_MISMATCH: "Document in another name",
  BANK_NAME_MISMATCH: "Bank account in another name",
  STRATEGIC_SIGNOFF_REQUIRED: "Strategic sign-off",
  GSTIN_INVALID: "GSTIN typo",
  PAN_INVALID: "PAN typo",
  IFSC_INVALID: "IFSC not a real branch",
  DOC_BANK_MISMATCH: "Cheque ≠ bank details",
  FIELD_MISSING: "Form incomplete",
  TAX_ID_FORMAT: "Tax ID wrong for country",
  IBAN_INVALID: "IBAN invalid",
  ROUTING_INVALID: "Routing number invalid",
  ACCOUNT_INVALID: "Account number invalid",
  CIN_INVALID: "CIN invalid",
  IFSC_BANK_MISMATCH: "IFSC ≠ bank name",
  DOC_NOT_READ_AI: "AI couldn't read a document",
  PAN_TYPE_MISMATCH: "PAN type ≠ business type",
  DOC_GSTIN_MISMATCH: "Certificate GSTIN ≠ form",
  DOC_PAN_MISMATCH: "PAN card ≠ form",
  DOC_COI_MISMATCH: "Incorporation cert. ≠ form",
  DUPLICATE_VENDOR: "Already a vendor",
  PAN_BELONGS_TO_OTHER_VENDOR: "PAN on another vendor",
};
const SEV: Record<string, { label: string; color: string }> = {
  fraud: { label: "integrity", color: "var(--reject)" },
  vendor_fixable: { label: "vendor fix", color: "var(--wait)" },
  needs_review: { label: "needs person", color: "var(--review)" },
  signoff: { label: "sign-off", color: "var(--review)" },
};

function duration(ms: number) {
  const m = ms / 60000;
  if (m < 1) return "under a minute";
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function approvedAt(c: Case) {
  if (c.final?.status === "APPROVED") return c.final.at;
  return c.runs.find((r) => r.decision.status === "APPROVED")?.at;
}

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

function Bars({ rows, max }: { rows: { label: string; value: number; color?: string; tag?: string }[]; max: number }) {
  return (
    <ul className="grid gap-2">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(120px,190px)_1fr_auto] items-center gap-3 text-[14px]" title={`${r.label}: ${r.value}`}>
          <span className="truncate">{r.label}</span>
          <span className="h-3 rounded-r-[4px] bg-tint" aria-hidden>
            <span className="block h-3 rounded-r-[4px]" style={{ width: `${max ? Math.max(2, (100 * r.value) / max) : 0}%`, background: r.color ?? "var(--ink)" }} />
          </span>
          <span className="min-w-[2ch] text-right font-semibold tabular-nums">
            {r.value}
            {r.tag && <span className="ml-1.5 text-[12px] font-normal text-ink-3">{r.tag}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function Dashboard() {
  const s = useStore();
  const now = s.now();
  const cases = s.cases;
  const submitted = cases.filter((c) => c.runs.length);

  if (!submitted.length)
    return (
      <Section title="Dashboard">
        <p className="py-8 text-center text-ink-2">
          No submissions yet. Go to <Link className="underline" href="/">Cases</Link> and use “Run all … at once” in the sample vendors panel to fill this in.
        </p>
      </Section>
    );

  const neededPerson = submitted.filter((c) => c.final || c.runs.some((r) => r.decision.status === "PENDING_INTERNAL" && r.trigger !== "policy_change"));
  const noPerson = submitted.length - neededPerson.length;
  const approvalTimes = submitted.map((c) => {
    const a = approvedAt(c);
    return a ? new Date(a).getTime() - new Date(c.runs[0].at).getTime() : null;
  }).filter((x): x is number => x !== null);
  const med = median(approvalTimes);
  const waiting = cases.filter((c) => caseStatus(c) === "PENDING_VENDOR");
  const fraud = submitted.filter((c) => c.runs.at(-1)!.checks.some((k) => k.hard && k.outcome === "fail"));

  const funnel = [
    { label: "Invited", value: cases.length },
    { label: "Submitted", value: submitted.length },
    { label: "Clean first time", value: submitted.filter((c) => c.runs[0].decision.status === "APPROVED").length },
    { label: "Approved now", value: cases.filter((c) => caseStatus(c) === "APPROVED").length },
  ];

  const blockers = new Map<string, { n: number; sev: string }>();
  for (const c of submitted)
    for (const r of c.runs[0].decision.reasons) {
      const b = blockers.get(r.code) ?? { n: 0, sev: r.severity };
      b.n++;
      blockers.set(r.code, b);
    }
  const blockerRows = [...blockers.entries()].sort((a, b) => b[1].n - a[1].n).map(([code, b]) => ({
    label: REASON_LABEL[code] ?? code, value: b.n, color: SEV[b.sev]?.color, tag: SEV[b.sev]?.label,
  }));

  const statusRows = (["APPROVED", "PENDING_VENDOR", "PENDING_INTERNAL", "REJECTED", "EXPIRED", "INVITED"] as const)
    .map((st) => ({ label: STATUS_META[st].label, value: cases.filter((c) => caseStatus(c) === st).length, color: STATUS_META[st].color }))
    .filter((r) => r.value);

  const reruns = submitted.flatMap((c) => c.runs.slice(1));
  const skipped = reruns.reduce((a, r) => a + r.checks.filter((k) => k.carried_over).length, 0);
  const rerunTotal = reruns.reduce((a, r) => a + r.checks.length, 0);
  const byRule = submitted.filter((c) => c.runs.some((r) => r.trigger === "policy_change" && r.decision.status === "APPROVED")).length;
  const docs = submitted.flatMap((c) => Object.values(c.readings));
  const live = docs.filter((d) => d!.source === "ai").length;
  const recorded = docs.filter((d) => d!.source === "cache").length;
  const avgConf = docs.length ? docs.reduce((a, d) => a + d!.confidence, 0) / docs.length : 0;
  const sent = (k: string) => s.outbox.filter((m) => m.kind === k).length;

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile value={`${noPerson} of ${submitted.length}`} label="Handled with no person involved" note="Approved, rejected or sent back automatically" />
        <Tile value={med === null ? "—" : duration(med)} label="Median time to approval" note={`From submission, across ${approvalTimes.length} approved`} />
        <Tile value={String(waiting.length)} label="Pending on vendors" note={waiting.length ? `Oldest: ${Math.max(...waiting.map((c) => daysWaiting(c, now)))} days` : "None"} />
        <Tile value={String(fraud.length)} label="Stopped by fraud checks" note="Can't be overridden" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="From invite to approval">
          <Bars rows={funnel} max={funnel[0].value} />
        </Section>
        <Section title="Where vendors get stuck" aside={<span className="text-[13px] text-ink-3">First submission</span>}>
          {blockerRows.length ? <Bars rows={blockerRows} max={Math.max(...blockerRows.map((r) => r.value))} /> : <p className="text-[14px] text-ink-2">Every first submission was clean.</p>}
        </Section>
        <Section title="Where every case is now">
          <Bars rows={statusRows} max={Math.max(...statusRows.map((r) => r.value))} />
        </Section>
        <Section title="What the automation saved">
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-[14px]">
            <dt>Follow-ups sent without anyone chasing</dt>
            <dd className="text-right font-semibold">{sent("request") + sent("reminder")} <span className="font-normal text-ink-3">({sent("reminder")} reminders)</span></dd>
            <dt>Escalated to a buyer</dt>
            <dd className="text-right font-semibold">{sent("escalation")}</dd>
            <dt>Checks skipped when re-checking (inputs unchanged)</dt>
            <dd className="text-right font-semibold">{skipped} <span className="font-normal text-ink-3">of {rerunTotal}</span></dd>
            <dt>Rules taught by reviewers</dt>
            <dd className="text-right font-semibold">{s.policy.version - 1}</dd>
            <dt>Cases resolved by a taught rule, no person needed</dt>
            <dd className="text-right font-semibold">{byRule}</dd>
            <dt>Documents read by AI</dt>
            <dd className="text-right font-semibold">
              {docs.length} <span className="font-normal text-ink-3">({live} live, {recorded} recorded · avg {Math.round(avgConf * 100)}% sure)</span>
            </dd>
          </dl>
        </Section>
      </div>

      {waiting.length > 0 && (
        <Section title="Waiting on vendors" aside={<span className="text-[13px] text-ink-3">The follow-up agent handles these</span>}>
          <table className="w-full text-left text-[14px]">
            <thead className="text-[13px] text-ink-3">
              <tr className="border-b border-rule">
                <th className="py-1.5 font-medium">Vendor</th>
                <th className="py-1.5 font-medium">Waiting for</th>
                <th className="py-1.5 font-medium">Days</th>
                <th className="hidden py-1.5 font-medium sm:table-cell">Next step</th>
              </tr>
            </thead>
            <tbody>
              {waiting.map((c) => {
                const n = nextFollowUp(c, now);
                return (
                  <tr key={c.id} className="border-b border-rule last:border-0">
                    <td className="py-2"><Link className="font-semibold hover:underline" href={`/cases/${c.id}`}>{caseName(c)}</Link></td>
                    <td className="py-2 text-ink-2">{c.runs.at(-1)!.decision.reasons.map((r) => REASON_LABEL[r.code] ?? r.code).join(", ")}</td>
                    <td className="py-2 tabular-nums">{daysWaiting(c, now)}</td>
                    <td className="hidden py-2 text-ink-2 sm:table-cell">{n ? `${n.what}, day ${n.day}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>
      )}
    </div>
  );
}
