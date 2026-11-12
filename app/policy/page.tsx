"use client";
import Link from "next/link";
import { useStore } from "@/lib/client/store";
import { HARD_CODES, HARD_LABEL } from "@/lib/engine/policy";
import { DOC_LABEL } from "@/lib/engine/types";
import { RequirementsPanel } from "@/components/RequirementsPanel";
import { Section, fmtTime, inr } from "@/components/ui";


export default function PolicyPage() {
  const { policy: p } = useStore();
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Section title={`Rules in force: policy v${p.version}`}>
        <h3 className="text-[14px] font-bold">How much checking</h3>
        <table className="mt-1 w-full text-[14px]">
          <tbody className="divide-y divide-rule">
            <tr><td className="py-1.5 pr-3 font-semibold">Low risk</td><td>Under {inr(p.tiers.low_max_inr)} a year, no data access</td><td className="text-ink-2">{p.required_docs.LOW.map((d) => DOC_LABEL[d]).join(", ")}</td></tr>
            <tr><td className="py-1.5 pr-3 font-semibold">Standard</td><td>{inr(p.tiers.low_max_inr)} to {inr(p.tiers.standard_max_inr)}</td><td className="text-ink-2">+ PAN card</td></tr>
            <tr><td className="py-1.5 pr-3 font-semibold">Strategic</td><td>Over {inr(p.tiers.standard_max_inr)}, or data access</td><td className="text-ink-2">+ Certificate of incorporation; a person always signs off</td></tr>
          </tbody>
        </table>
        <h3 className="mt-5 text-[14px] font-bold">Taught by reviewers</h3>
        {p.name_equivalences.length === 0 ? (
          <p className="text-[14px] text-ink-2">None yet. When a reviewer approves a near-match and explains why, they can turn it into a rule here.</p>
        ) : (
          <ul className="mt-1 grid gap-1 text-[14px]">
            {p.name_equivalences.map((e, i) => (
              <li key={i}>
                “{e.phrases[0]}” = “{e.phrases.slice(1).join("”, “")}” in business names{e.constitutions?.length ? `, for ${e.constitutions.map((c) => (c === "proprietor" ? "sole proprietors" : c)).join(", ")}` : ""}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[13px] text-ink-3">AI confidence below {Math.round(p.min_doc_confidence * 100)}% on a document asks the vendor for a clearer copy.</p>
      </Section>

      <Section title="Fraud checks no one can override">
        <p className="mb-2 text-[14px] text-ink-2">
          These reject a vendor outright. They can&apos;t be approved by hand or relaxed by a taught rule. Taught rules can only settle names that were already close, and can&apos;t
          contain words from a specific vendor&apos;s name.
        </p>
        <ul className="list-disc pl-5 text-[14px]">
          {[...HARD_CODES].map((c) => <li key={c}>{(HARD_LABEL[c] ?? c).replace(/^./, (x) => x.toUpperCase())}</li>)}
        </ul>
      </Section>

      <RequirementsPanel />

      <Section title="Change history" className="lg:col-span-2">
        <ol className="grid gap-3 text-[14px]">
          {[...p.history].reverse().map((h) => (
            <li key={h.version} className="grid gap-x-4 sm:grid-cols-[70px_150px_1fr]">
              <span className="font-bold">v{h.version}</span>
              <span className="text-ink-3">{h.by === "system" ? "Initial setup" : `${fmtTime(h.at)}`}</span>
              <span>
                {h.summary}
                {h.reviewer_note && <span className="block text-ink-2">Reviewer&apos;s reason: “{h.reviewer_note}” ({h.by}{h.source_case ? <>, from <Link className="underline" href={`/cases/${h.source_case}`}>{h.source_case}</Link></> : null})</span>}
              </span>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}
