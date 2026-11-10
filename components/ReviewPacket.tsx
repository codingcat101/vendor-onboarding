"use client";
// "Prepared for review": everything a reviewer, auditor or ERP needs about one vendor, in one place.
// A vendor record draft, an evidence checklist and an exception report, downloadable as JSON or CSV.
import { useState } from "react";
import { Case, CaseRun, caseStatus, useStore } from "@/lib/client/store";
import { Policy, requiredDocs } from "@/lib/engine/policy";
import { CheckResult, DocSlot, docLabel } from "@/lib/engine/types";
import { STATUS_META, Section } from "./ui";

/** Which check confirms each document matches the form. */
const MATCH_CHECK: Record<DocSlot, string> = {
  gst_certificate: "gst_doc_matches",
  pan_card: "pan_doc_matches",
  cancelled_cheque: "cheque_matches",
  incorporation_certificate: "coi_matches",
  security_certificate: "security_cert_valid",
};

export function vendorRecord(c: Case, run: CaseRun) {
  const s = run.inputs.sub;
  return {
    vendor_id: c.id,
    legal_name: s.legal_name,
    trade_name: s.trade_name ?? "",
    business_type: s.constitution,
    country: s.country,
    gstin: s.gstin ?? "",
    pan: s.pan ?? "",
    tax_id: s.tax_id ?? "",
    cin: s.cin ?? "",
    address: `${s.address.line1}, ${s.address.city}, ${s.address.state} ${s.address.pincode}`,
    bank_account_holder: s.bank.account_holder,
    bank_account_number: s.bank.account_number,
    bank_code: s.bank.ifsc ?? "",
    bank_name: s.bank.bank_name,
    contact_name: s.contact.name,
    contact_email: s.contact.email,
    category: c.invite.category,
    annual_spend_inr: c.invite.annual_spend_inr,
    data_access: c.invite.data_access,
    risk_tier: run.tier,
    status: STATUS_META[caseStatus(c)].label,
    policy_version: run.policy_version,
  };
}

function evidence(c: Case, run: CaseRun, policy: Policy) {
  const sub = run.inputs.sub;
  const byId = new Map(run.checks.map((k) => [k.id, k]));
  return requiredDocs(run.tier, sub, policy, c.invite).map((slot) => {
    const r = run.inputs.docs[slot];
    const match = byId.get(MATCH_CHECK[slot]);
    const typeCheck = byId.get(`doc_${slot}`);
    return {
      document: docLabel(slot, sub.country),
      received: !!sub.documents[slot],
      read_as: r ? `${r.doc_type.replace(/_/g, " ")} (${Math.round(r.confidence * 100)}%)` : "",
      right_type: typeCheck?.outcome === "pass",
      matches_form: match ? match.outcome : "n/a",
    };
  });
}

const exceptions = (run: CaseRun) => run.checks.filter((k) => k.outcome === "fail" || k.outcome === "warn");

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

const SEV_LABEL: Record<string, string> = { fraud: "Integrity", vendor_fixable: "Vendor fix", needs_review: "Needs a person" };

export function ReviewPacket({ c, run }: { c: Case; run: CaseRun }) {
  const s = useStore();
  const [tab, setTab] = useState<"record" | "evidence" | "exceptions">("record");
  const rec = vendorRecord(c, run);
  const ev = evidence(c, run, s.policy);
  const ex = exceptions(run);
  const mask = (k: string, v: unknown) => (k === "bank_account_number" ? `••••${String(v).slice(-4)}` : String(v));

  const packet = () => ({
    prepared_at: s.now().toISOString(),
    vendor_record_draft: rec,
    evidence_checklist: ev,
    exception_report: ex.map((k: CheckResult) => ({ check: k.title, outcome: k.outcome, severity: k.severity ?? "warning", code: k.code ?? "", message: k.message, evidence: k.evidence ?? {}, cannot_be_overridden: !!k.hard })),
    decision: run.decision,
    reviewer_decision: c.final ?? null,
    all_checks: run.checks,
    activity: c.events,
    messages: s.outbox.filter((m) => m.case_id === c.id),
  });

  const TABS = [
    { id: "record", label: "Vendor record draft" },
    { id: "evidence", label: `Evidence checklist (${ev.filter((e) => e.received && e.right_type).length}/${ev.length})` },
    { id: "exceptions", label: `Exceptions (${ex.length})` },
  ] as const;

  return (
    <Section
      title="Prepared for review"
      aside={
        <span className="flex gap-2">
          <button className="btn btn-quiet !px-2.5 !py-1 text-[13px]" onClick={() => download(`${c.id}-review-packet.json`, JSON.stringify(packet(), null, 2), "application/json")}>
            Download packet (JSON)
          </button>
          <button
            className="btn btn-quiet !px-2.5 !py-1 text-[13px]"
            onClick={() => download(`${c.id}-vendor-record.csv`, `${Object.keys(rec).join(",")}\n${Object.values(rec).map(csvCell).join(",")}\n`, "text/csv")}
          >
            Vendor record (CSV)
          </button>
        </span>
      }
    >
      <div role="tablist" className="mb-3 flex flex-wrap gap-1 border-b border-rule">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-[14px] ${tab === t.id ? "border-ink font-semibold" : "border-transparent text-ink-2 hover:text-ink"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "record" && (
        <>
          <dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-1 text-[14px] sm:grid-cols-[170px_1fr]">
            {Object.entries(rec)
              .filter(([, v]) => v !== "" && v !== null)
              .map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-ink-3">{k.replace(/_/g, " ")}</dt>
                  <dd className={/gstin|pan|cin|tax_id|bank_account_number|bank_code|vendor_id/.test(k) ? "id break-all" : "break-words"}>{mask(k, v)}</dd>
                </div>
              ))}
          </dl>
          <p className="mt-3 text-[13px] text-ink-3">Ready to load into the vendor master (SAP, Oracle, Workday) once approved. The CSV has the full account number.</p>
        </>
      )}

      {tab === "evidence" && (
        <table className="w-full text-left text-[14px]">
          <thead className="text-[13px] text-ink-3">
            <tr className="border-b border-rule">
              <th className="py-1.5 font-medium">Document</th>
              <th className="py-1.5 font-medium">Received</th>
              <th className="hidden py-1.5 font-medium sm:table-cell">Read by AI as</th>
              <th className="py-1.5 font-medium">Matches the form</th>
            </tr>
          </thead>
          <tbody>
            {ev.map((e) => (
              <tr key={e.document} className="border-b border-rule last:border-0">
                <td className="py-1.5 pr-2">{e.document}</td>
                <td className="py-1.5">{e.received ? (e.right_type ? "Yes" : "Yes, wrong type") : <b className="text-wait">Missing</b>}</td>
                <td className="hidden py-1.5 text-ink-2 sm:table-cell">{e.read_as || "—"}</td>
                <td className="py-1.5">
                  {e.matches_form === "pass" ? "Yes" : e.matches_form === "fail" ? <b className="text-reject">No</b> : e.matches_form === "warn" ? "Yes, with a note" : "Not checked yet"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "exceptions" &&
        (ex.length === 0 ? (
          <p className="text-[14px] text-ink-2">No exceptions. Every check passed.</p>
        ) : (
          <ul className="grid gap-2 text-[14px]">
            {ex.map((k) => (
              <li key={k.id} className="rounded-lg border border-rule px-3 py-2">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <b>{k.title}</b>
                  <span className="text-[12px] text-ink-3">{k.outcome === "warn" ? "Note" : SEV_LABEL[k.severity!]}{k.hard ? " · can't be overridden" : ""}</span>
                  {k.code && <span className="id text-[12px] text-ink-3">{k.code}</span>}
                </div>
                <p className="text-ink-2">{k.message}</p>
              </li>
            ))}
          </ul>
        ))}
    </Section>
  );
}
