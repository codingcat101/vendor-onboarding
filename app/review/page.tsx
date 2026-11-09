"use client";
import Link from "next/link";
import { daysWaiting } from "@/lib/client/agent";
import { caseName, caseStatus, useStore } from "@/lib/client/store";
import { Section, TierTag } from "@/components/ui";

export default function ReviewQueue() {
  const s = useStore();
  const now = s.now();
  const queue = s.cases.filter((c) => caseStatus(c) === "PENDING_INTERNAL").sort((a, b) => (a.runs.at(-1)!.at < b.runs.at(-1)!.at ? -1 : 1));
  return (
    <Section title="Review queue" aside={<span className="text-[13px] text-ink-3">Oldest first</span>}>
      {queue.length === 0 ? (
        <p className="py-8 text-center text-ink-2">Nothing needs a person right now. Cases appear here when a check is unclear or a strategic vendor needs a sign-off.</p>
      ) : (
        <ul className="-my-2 divide-y divide-rule">
          {queue.map((c) => {
            const r = c.runs.at(-1)!.decision.reasons;
            const d = daysWaiting(c, now);
            return (
              <li key={c.id} className="flex flex-wrap items-start gap-3 py-3">
                <div className="min-w-[240px] flex-1">
                  <Link href={`/cases/${c.id}`} className="font-semibold hover:underline">{caseName(c)}</Link>{" "}
                  <TierTag tier={c.tier} />
                  <ul className="mt-1 text-[14px] text-ink-2">
                    {r.map((x) => <li key={x.code}>{x.message}</li>)}
                  </ul>
                </div>
                <span className="text-[13px] text-ink-3">{d === 0 ? "Today" : `Waiting ${d} day${d > 1 ? "s" : ""}`}</span>
                <Link className="btn btn-quiet !py-1 text-[13px]" href={`/cases/${c.id}`}>Review</Link>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
