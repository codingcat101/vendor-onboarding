"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { caseName, caseStatus, useStore } from "@/lib/client/store";
import { SAMPLE_BLURB, useScenarios } from "@/lib/client/scenarios";
import { Section, StatusBadge, TierTag, fmtTime } from "@/components/ui";

export default function CasesPage() {
  const s = useStore();
  const router = useRouter();
  const samples = useScenarios();

  const startSample = (id: string) => {
    const sc = samples?.find((x) => x.id === id);
    if (!sc) return;
    const c = s.createCase(
      { ...sc.invite, vendor_name: sc.sub.trade_name || sc.sub.legal_name, vendor_email: sc.sub.contact.email },
      sc.id,
    );
    s.setRole("vendor");
    router.push(`/vendor/${c.id}`);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <Section
        title="Cases"
        aside={
          s.role === "buyer" ? (
            <Link href="/invite" className="btn">
              Invite a vendor
            </Link>
          ) : null
        }
      >
        {s.cases.length === 0 ? (
          <div className="py-10 text-center text-ink-2">
            <p className="font-semibold text-ink">No vendors yet</p>
            <p className="mx-auto mt-1 max-w-[42ch]">Invite a vendor, or play one of the sample vendors on the right to see how each kind of problem is handled.</p>
          </div>
        ) : (
          <div className="-mx-4 -my-4 overflow-x-auto">
            <table className="w-full text-left text-[14px]">
              <thead className="text-[13px] text-ink-3">
                <tr className="border-b border-rule">
                  <th className="px-4 py-2 font-medium">Vendor</th>
                  <th className="px-2 py-2 font-medium">Tier</th>
                  <th className="px-2 py-2 font-medium">Status</th>
                  <th className="hidden px-4 py-2 font-medium text-right sm:table-cell">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {s.cases.map((c) => (
                  <tr key={c.id} className="border-b border-rule last:border-0 hover:bg-paper">
                    <td className="px-4 py-2.5">
                      <Link href={`/cases/${c.id}`} className="font-semibold hover:underline">
                        {caseName(c)}
                      </Link>
                      <div className="text-[13px] text-ink-3">
                        <span className="id">{c.id}</span> · {c.invite.category}
                      </div>
                    </td>
                    <td className="px-2 py-2.5">
                      <TierTag tier={c.tier} why={c.tier_why} />
                    </td>
                    <td className="px-2 py-2.5">
                      <StatusBadge status={caseStatus(c)} />
                    </td>
                    <td className="hidden px-4 py-2.5 text-right text-[13px] text-ink-2 sm:table-cell">{fmtTime(c.events.at(-1)!.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Sample vendors">
        <p className="mb-3 text-[14px] text-ink-2">
          Each one is invited by a buyer, then you fill in the vendor&apos;s form with their details and documents, already prepared.
        </p>
        <ul className="divide-y divide-rule">
          {(samples ?? []).map((sc) => (
            <li key={sc.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{SAMPLE_BLURB[sc.id]?.name}</div>
                <div className="text-[13px] text-ink-2">{SAMPLE_BLURB[sc.id]?.what}</div>
              </div>
              <button className="btn btn-quiet !px-3 !py-1 text-[13px]" onClick={() => startSample(sc.id)} aria-label={`Start ${SAMPLE_BLURB[sc.id]?.name}`}>
                Start
              </button>
            </li>
          ))}
          {!samples && <li className="py-3 text-ink-3">Loading samples…</li>}
        </ul>
      </Section>
    </div>
  );
}
