"use client";
import Link from "next/link";
import { useStore } from "@/lib/client/store";
import { Section, fmtTime } from "@/components/ui";

const KIND: Record<string, string> = { request: "Request", reminder: "Reminder", escalation: "Escalation", approved: "Approved", rejected: "Closed" };

export default function Outbox() {
  const s = useStore();
  return (
    <Section
      title="Messages sent"
      aside={
        <span className="flex items-center gap-2 text-[13px] text-ink-3">
          Simulate time passing:
          <button className="btn btn-quiet !px-2 !py-0.5 text-[13px]" onClick={() => s.advanceClock(1)}>+1 day</button>
          <button className="btn btn-quiet !px-2 !py-0.5 text-[13px]" onClick={() => s.advanceClock(3)}>+3 days</button>
        </span>
      }
    >
      <p className="mb-3 max-w-[70ch] text-[14px] text-ink-2">
        Everything the follow-up agent sent. In a live setup these go out by email; here they stay in the sandbox. Requests and reminders are drafted by AI from a fixed
        template, and are only used if they keep every requested item and the fix link.
      </p>
      {s.outbox.length === 0 ? (
        <p className="py-6 text-center text-ink-2">No messages yet.</p>
      ) : (
        <ul className="grid gap-2">
          {s.outbox.map((m) => (
            <li key={m.id}>
              <details className="rounded border border-rule px-3 py-2">
                <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 text-[14px]">
                  <span className="w-[86px] text-[13px] font-semibold text-ink-2">{KIND[m.kind]}</span>
                  <span className="min-w-0 flex-1 font-semibold">{m.subject}</span>
                  <span className="text-[13px] text-ink-3">to {m.to} · {fmtTime(m.at)}</span>
                </summary>
                <pre className="mt-2 whitespace-pre-wrap font-sans text-[14px] text-ink-2">{m.body}</pre>
                <p className="mt-2 text-[12px] text-ink-3">
                  {m.drafted_by === "template" ? "From template" : `Drafted by ${m.drafted_by}`} ·{" "}
                  <Link className="underline" href={`/cases/${m.case_id}`}>Open case</Link>
                </p>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
