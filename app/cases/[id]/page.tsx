"use client";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { pendingJobs } from "@/lib/client/jobs";
import { processSubmission, uploadPreviews } from "@/lib/client/pipeline";
import { sampleFileUrl } from "@/lib/client/scenarios";
import { Case, CaseRun, Reading, caseName, caseStatus, useStore } from "@/lib/client/store";
import { CheckResult, DOC_LABEL, DocSlot, STAGES, Stage } from "@/lib/engine/types";
import { STATUS_META, Section, Stamp, TierTag, fmtTime, inr } from "@/components/ui";

type LiveDoc = { state: "start" | "reused" | "done"; reading?: Reading };

export default function CasePageWrapper() {
  return (
    <Suspense>
      <CasePage />
    </Suspense>
  );
}

function CasePage() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const s = useStore();
  const c = s.cases.find((x) => x.id === id);

  const [live, setLive] = useState<{ docs: Partial<Record<DocSlot, LiveDoc>>; phase: "reading" | "checking" | "revealing" | "done"; error?: string } | null>(null);
  const [revealed, setRevealed] = useState<number>(STAGES.length);
  const started = useRef(false);

  // Run a freshly submitted job live.
  useEffect(() => {
    if (!c || started.current || search.get("live") !== "1") return;
    const job = pendingJobs.get(c.id);
    if (!job) return;
    started.current = true;
    pendingJobs.delete(c.id);
    setRevealed(0);
    setLive({ docs: {}, phase: "reading" });
    s.addEvent(c.id, {
      actor: c.invite.vendor_name, kind: "submit",
      text: job.trigger === "resubmission" ? "Vendor sent fixes" : `Vendor submitted details and ${Object.keys(job.sub.documents).length} documents`,
    });
    processSubmission({
      c, sub: job.sub, uploads: job.uploads, policy: s.policy, extraMaster: s.approvedVendors(), trigger: job.trigger, at: s.now().toISOString(),
      onProgress: (p) =>
        setLive((l) => {
          if (!l) return l;
          if (p.phase === "checking") return { ...l, phase: "checking" };
          return { ...l, docs: { ...l.docs, [p.slot]: { state: p.state, reading: p.reading } } };
        }),
    })
      .then((run) => {
        s.updateCase(c.id, (old) => ({
          ...old, sub: run.inputs.sub, readings: run.inputs.docs, runs: [...old.runs, run], final: undefined,
          events: [...old.events, { at: run.at, actor: "Process", kind: "decision", text: `decided: ${STATUS_META[run.decision.status].label.toLowerCase()}. ${run.decision.summary}` }],
        }));
        setLive((l) => (l ? { ...l, phase: "revealing" } : l));
        router.replace(`/cases/${c.id}`);
      })
      .catch((e) => setLive((l) => (l ? { ...l, phase: "done", error: String(e.message ?? e) } : l)));
  }, [c, search, s, router]);

  // Reveal stages one after another once the result is in.
  useEffect(() => {
    if (live?.phase !== "revealing") return;
    if (revealed >= STAGES.length) {
      setLive((l) => (l ? { ...l, phase: "done" } : l));
      return;
    }
    const t = setTimeout(() => setRevealed((r) => r + 1), revealed === 0 ? 150 : 420);
    return () => clearTimeout(t);
  }, [live?.phase, revealed]);

  if (!c) return <p>Case not found. It may have been cleared with “Reset demo”. <Link className="underline" href="/">Back to cases</Link></p>;

  const run = live && live.phase !== "revealing" && live.phase !== "done" ? undefined : c.runs.at(-1);
  const status = caseStatus(c);
  const showStamp = run && revealed >= STAGES.length;
  const docs = live?.phase === "reading" || live?.phase === "checking" ? live.docs : null;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/" className="text-[13px] text-ink-3 hover:text-ink">← Cases</Link>
          <h1 className="text-[26px] font-extrabold leading-tight tracking-tight">{caseName(c)}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-ink-2">
            <span className="id">{c.id}</span>
            <span aria-hidden>·</span>
            <span>{c.invite.category}, {inr(c.invite.annual_spend_inr)}/yr{c.invite.data_access ? ", data access" : ""}</span>
            <span aria-hidden>·</span>
            <span>Invited by {c.invite.buyer}</span>
            <TierTag tier={c.tier} why={c.tier_why} />
          </p>
        </div>
        <div className="min-h-[64px] pr-2 pt-2">
          {showStamp && (
            <Stamp
              status={status}
              animate={live?.phase === "revealing" || live?.phase === "done"}
              sub={c.final ? `by ${c.final.by.split(" (")[0]}` : `policy v${run!.policy_version} · run ${c.runs.length}`}
            />
          )}
        </div>
      </div>

      {status === "INVITED" && !live && (
        <Section title="Waiting for the vendor" className="mb-6">
          <p className="text-[14px] text-ink-2">
            {c.invite.vendor_name} has been invited at <span className="id">{c.invite.vendor_email}</span>. The tier is <b>{c.tier.toLowerCase()}</b> because {c.tier_why.charAt(0).toLowerCase() + c.tier_why.slice(1)}.
          </p>
          <div className="mt-3">
            <Link className="btn btn-quiet" href={`/vendor/${c.id}`} onClick={() => s.setRole("vendor")}>
              Open the vendor&apos;s form
            </Link>
          </div>
        </Section>
      )}

      {live?.error && (
        <p className="mb-4 rounded border px-3 py-2" style={{ borderColor: "var(--reject)", background: "var(--reject-bg)" }}>
          The checks could not run: {live.error}. Try submitting again.
        </p>
      )}

      {(c.sub || live) && (
        <div className="grid items-start gap-6 lg:grid-cols-[380px_1fr]">
          <div className="grid gap-6">
            <DocumentsPanel c={c} liveDocs={docs} run={run} />
            {c.sub && <DetailsPanel c={c} />}
          </div>
          <div className="grid gap-6">
            <ChecksPanel run={run} revealed={revealed} phase={live?.phase} />
            {run && revealed >= STAGES.length && <NextStep c={c} run={run} />}
            <ActivityPanel c={c} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function docHref(ref: string | undefined) {
  if (!ref) return null;
  const m = ref.match(/^(V\d{2})\/(.+)$/);
  if (m) return sampleFileUrl(m[1], m[2]);
  return uploadPreviews.get(ref) ?? null;
}

const ID_FIELDS = new Set(["gstin", "pan", "account_number", "ifsc", "cin"]);
const DOC_TYPE_NAME: Record<string, string> = { ...DOC_LABEL, invoice: "an invoice", bank_letter: "bank letter", other: "something else" };

const SOURCE_LABEL: Record<string, string> = {
  ai: "Read by AI just now",
  cache: "AI reading recorded earlier",
  ground_truth: "Reference reading",
};

function DocumentsPanel({ c, liveDocs, run }: { c: Case; liveDocs: Partial<Record<DocSlot, LiveDoc>> | null; run?: CaseRun }) {
  const sub = run?.inputs.sub ?? c.sub;
  const slots = Object.keys(liveDocs ?? sub?.documents ?? {}) as DocSlot[];
  const reused = new Set(
    run && c.runs.length > 1
      ? slots.filter((sl) => !run.changed?.includes(`doc.${sl}`))
      : [],
  );
  return (
    <Section title="Documents">
      {slots.length === 0 && <p className="text-[14px] text-ink-3">No documents uploaded.</p>}
      <ul className="grid gap-4">
        {slots.map((slot) => {
          const ld = liveDocs?.[slot];
          const r = ld?.reading ?? run?.inputs.docs[slot];
          const href = docHref(sub?.documents[slot]);
          const wrongType = r && r.doc_type !== slot;
          return (
            <li key={slot} className="reveal">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">{DOC_LABEL[slot]}</span>
                {href && (
                  <a href={href} target="_blank" rel="noreferrer" className="text-[13px] text-ink-2 underline">
                    View
                  </a>
                )}
              </div>
              {ld?.state === "start" ? (
                <p className="mt-1 text-[14px] text-ink-2">
                  <span className="pulse mr-1.5 inline-block h-2 w-2 rounded-full bg-review align-middle" aria-hidden />
                  Reading with AI…
                </p>
              ) : r ? (
                <div className="mt-1 text-[13px]">
                  <p className={wrongType ? "font-semibold text-wait" : "text-ink-2"}>
                    {r.error ? `Could not read: ${r.error}` : `Looks like: ${DOC_TYPE_NAME[r.doc_type] ?? r.doc_type.replace(/_/g, " ")} · ${Math.round(r.confidence * 100)}% sure`}
                  </p>
                  {Object.keys(r.fields).length > 0 && (
                    <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded bg-paper px-2.5 py-2">
                      {Object.entries(r.fields).map(([k, v]) => (
                        <div key={k} className="contents">
                          <dt className="text-ink-3">{k.replace(/_/g, " ")}</dt>
                          <dd className={ID_FIELDS.has(k) ? "id break-all" : "break-words"}>{v}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  <p className="mt-1 text-ink-3">
                    {ld?.state === "reused" || reused.has(slot) ? "Unchanged since last submission, reading reused" : SOURCE_LABEL[r.source]}
                    {r.model && r.source === "ai" ? ` (${r.model})` : ""}
                    {r.ms ? ` · ${(r.ms / 1000).toFixed(1)}s` : ""}
                    {r.notes ? ` · ${r.notes}` : ""}
                  </p>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="mt-4 border-t border-rule pt-3 text-[13px] text-ink-3">
        The AI only sees the document, never the form, so it reports what is printed rather than what the vendor typed.
      </p>
    </Section>
  );
}

function DetailsPanel({ c }: { c: Case }) {
  const sub = c.sub!;
  const rows: [string, string, boolean?][] = [
    ["Legal name", sub.legal_name],
    ["Trade name", sub.trade_name || "—"],
    ["Type", sub.constitution],
    ["Address", `${sub.address.line1}, ${sub.address.city}, ${sub.address.state} ${sub.address.pincode}`],
    ["GSTIN", sub.gstin || "—", true],
    ["PAN", sub.pan || "—", true],
    ...(sub.cin ? ([["CIN", sub.cin, true]] as [string, string, boolean][]) : []),
    ["Account holder", sub.bank.account_holder],
    ["Account", sub.bank.account_number, true],
    ["IFSC", `${sub.bank.ifsc} (${sub.bank.bank_name})`, true],
    ["Contact", `${sub.contact.name}, ${sub.contact.email}`],
  ];
  return (
    <Section title="What the vendor entered">
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[14px]">
        {rows.map(([k, v, mono]) => (
          <div key={k} className="contents">
            <dt className="text-ink-3">{k}</dt>
            <dd className={`${mono ? "id" : ""} break-words`}>{v}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

// ---------------------------------------------------------------------------
const SEV_COLOR = { fraud: "var(--reject)", vendor_fixable: "var(--wait)", needs_review: "var(--review)" } as const;
const SEV_LABEL = { fraud: "Integrity problem", vendor_fixable: "Vendor can fix", needs_review: "Needs a person" } as const;

function Mark({ k }: { k: CheckResult }) {
  const color = k.outcome === "pass" ? "var(--approve)" : k.outcome === "fail" ? SEV_COLOR[k.severity!] : "var(--ink-3)";
  const glyph = k.outcome === "pass" ? "✓" : k.outcome === "fail" ? "✕" : k.outcome === "warn" ? "!" : "–";
  return (
    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-white" style={{ background: color }} aria-label={k.outcome}>
      {glyph}
    </span>
  );
}

function ChecksPanel({ run, revealed, phase }: { run?: CaseRun; revealed: number; phase?: string }) {
  const stages = STAGES.filter((st) => st.id !== "intake" && st.id !== "decision");
  const total = run?.checks.length ?? 0;
  const ran = run?.rechecked?.length;
  return (
    <Section
      title="Checks"
      aside={
        run && ran !== undefined ? (
          <span className="text-[13px] text-ink-2">
            Re-checked {ran} of {total}. {total - ran} kept from the last run because nothing they depend on changed.
          </span>
        ) : run ? (
          <span className="text-[13px] text-ink-2">{run.checks.filter((k) => k.outcome === "pass").length} of {total} passed</span>
        ) : null
      }
    >
      {!run && (
        <p className="text-[14px] text-ink-2">
          {phase === "checking" ? "Running checks…" : "Checks run once every document has been read."}
        </p>
      )}
      {run && (
        <ol className="grid gap-5">
          {stages.map((st, i) => {
            const ks = run.checks.filter((k) => k.stage === st.id);
            if (!ks.length || revealed < i + 1) return null;
            const bad = ks.filter((k) => k.outcome === "fail").length;
            if (!bad) {
              const passed = ks.filter((k) => k.outcome === "pass").length;
              const kept = ks.filter((k) => k.carried_over).length;
              return (
                <li key={st.id} className="reveal">
                  <details className="group">
                    <summary className="flex cursor-pointer list-none items-center gap-2.5 text-[14px]">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-approve text-[12px] font-bold text-white" aria-hidden>✓</span>
                      <span className="font-bold">{st.label}</span>
                      <span className="text-ink-3">
                        {passed} of {ks.length} passed{kept ? `, ${kept} kept from last run` : ""}
                      </span>
                      <span className="ml-auto text-[13px] text-ink-3 group-open:hidden">Show</span>
                      <span className="ml-auto hidden text-[13px] text-ink-3 group-open:inline">Hide</span>
                    </summary>
                    <ul className="mt-1.5 grid gap-1.5 pl-1">
                      {ks.map((k) => (
                        <CheckRow key={k.id} k={k} />
                      ))}
                    </ul>
                  </details>
                </li>
              );
            }
            return (
              <li key={st.id} className="reveal">
                <h3 className="mb-1.5 flex items-baseline gap-2 text-[14px] font-bold">
                  {st.label}
                  <span className="font-normal text-ink-3">{bad ? `${bad} problem${bad > 1 ? "s" : ""}` : `${ks.filter((k) => k.outcome === "pass").length} passed`}</span>
                </h3>
                <ul className="grid gap-1.5">
                  {ks.map((k) => (
                    <CheckRow key={k.id} k={k} />
                  ))}
                </ul>
              </li>
            );
          })}
          {revealed >= STAGES.length && <DecisionBlock run={run} />}
        </ol>
      )}
    </Section>
  );
}

function CheckRow({ k }: { k: CheckResult }) {
  const hasEvidence = k.evidence && Object.keys(k.evidence).length > 0;
  return (
    <li
      className="flex gap-2.5 rounded px-2 py-1.5"
      style={k.outcome === "fail" ? { background: `color-mix(in srgb, ${SEV_COLOR[k.severity!]} 8%, white)` } : undefined}
    >
      <Mark k={k} />
      <div className="min-w-0 flex-1 text-[14px]">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={k.outcome === "fail" ? "font-semibold" : ""}>{k.title}</span>
          {k.outcome === "fail" && (
            <span className="text-[12px] font-semibold" style={{ color: SEV_COLOR[k.severity!] }}>
              {SEV_LABEL[k.severity!]}
            </span>
          )}
          {k.hard && <span className="rounded border border-reject px-1 text-[11px] font-semibold text-reject" title="No taught rule can override this check">fraud guardrail</span>}
          {k.carried_over && <span className="text-[12px] text-ink-3">kept from last run</span>}
        </div>
        <p className="text-ink-2">{k.message}</p>
        {hasEvidence && k.outcome === "fail" && (
          <details className="mt-0.5 text-[13px]">
            <summary className="cursor-pointer text-ink-3">Evidence</summary>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3">
              {Object.entries(k.evidence!).map(([a, b]) => (
                <div key={a} className="contents">
                  <dt className="text-ink-3">{a.replace(/_/g, " ")}</dt>
                  <dd className="id break-all">{String(b)}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </div>
    </li>
  );
}

function DecisionBlock({ run }: { run: CaseRun }) {
  const m = STATUS_META[run.decision.status];
  return (
    <li className="reveal rounded-md border-l-4 px-3 py-2.5" style={{ borderColor: m.color, background: m.bg }}>
      <h3 className="text-[14px] font-bold" style={{ color: m.color }}>Decision: {m.label}</h3>
      <p className="text-[14px]">{run.decision.summary}</p>
      <p className="mt-1 text-[13px] text-ink-2">
        Rule: any integrity problem rejects; anything the vendor can fix goes back to them; anything unclear goes to a person; otherwise approved
        {run.tier === "STRATEGIC" ? ", except strategic vendors, who always need a sign-off" : ""}.
      </p>
    </li>
  );
}

// ---------------------------------------------------------------------------
function NextStep({ c, run }: { c: Case; run: CaseRun }) {
  const s = useStore();
  const status = caseStatus(c);
  if (status === "PENDING_VENDOR")
    return (
      <Section title="Next: the vendor fixes these">
        <ul className="list-disc pl-5 text-[14px]">
          {run.decision.vendor_actions.map((a) => (
            <li key={a.code}>{a.message}</li>
          ))}
        </ul>
        <div className="mt-3">
          <Link className="btn btn-quiet" href={`/vendor/${c.id}`} onClick={() => s.setRole("vendor")}>
            Open the vendor&apos;s fix page
          </Link>
        </div>
      </Section>
    );
  if (status === "PENDING_INTERNAL")
    return (
      <Section title="Next: a reviewer decides">
        <ul className="list-disc pl-5 text-[14px]">
          {run.decision.reasons.map((r) => (
            <li key={r.code}>{r.message}</li>
          ))}
        </ul>
      </Section>
    );
  if (status === "APPROVED")
    return (
      <Section title="Vendor approved">
        <p className="text-[14px] text-ink-2">
          {caseName(c)} is now on the vendor list. Their GSTIN, PAN and bank account will be checked against every future vendor.
        </p>
      </Section>
    );
  return null;
}

function ActivityPanel({ c }: { c: Case }) {
  return (
    <Section title="Activity" aside={<span className="text-[13px] text-ink-3">Audit trail, newest last</span>}>
      <ol className="grid gap-2 text-[14px]">
        {c.events.map((e, i) => (
          <li key={i} className="grid grid-cols-[110px_1fr] gap-3">
            <span className="text-[13px] text-ink-3">{fmtTime(e.at)}</span>
            <span>
              <b className="font-semibold">{e.actor}</b> <span className="text-ink-2">{e.text}</span>
            </span>
          </li>
        ))}
      </ol>
    </Section>
  );
}
