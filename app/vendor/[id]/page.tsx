"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { pendingJobs } from "@/lib/client/jobs";
import { Upload, fileRef } from "@/lib/client/pipeline";
import { SAMPLE_BLURB, sampleFileUrl, useScenarios } from "@/lib/client/scenarios";
import { caseStatus, useStore } from "@/lib/client/store";
import { requiredDocs } from "@/lib/engine/policy";
import { DOC_LABEL, DocSlot, Submission } from "@/lib/engine/types";
import { Section } from "@/components/ui";

const BUYER_COMPANY = "Northwind Retail Pvt Ltd";
const CONSTITUTIONS = ["Private Limited Company", "Public Limited Company", "Limited Liability Partnership", "Partnership Firm", "Proprietorship"];
const ALL_SLOTS: DocSlot[] = ["gst_certificate", "pan_card", "cancelled_cheque", "incorporation_certificate"];

const emptySub = (name: string, email: string): Submission => ({
  legal_name: name, trade_name: "", constitution: CONSTITUTIONS[0], country: "IN",
  address: { line1: "", city: "", state: "", pincode: "" }, gstin: "", pan: "", cin: "",
  contact: { name: "", email, phone: "" }, bank: { account_holder: "", account_number: "", ifsc: "", bank_name: "" }, documents: {},
});

export default function VendorPortal() {
  const { id } = useParams<{ id: string }>();
  const s = useStore();
  const router = useRouter();
  const c = s.cases.find((x) => x.id === id);
  const samples = useScenarios();
  const sample = samples?.find((x) => x.id === c?.scenario);
  const last = c?.runs.at(-1);
  const isFix = !!last && ["PENDING_VENDOR", "EXPIRED"].includes(caseStatus(c!));

  const [sub, setSub] = useState<Submission | null>(null);
  const [uploads, setUploads] = useState<Partial<Record<DocSlot, Upload>>>({});

  // Prefill: previous submission (fix flow) > sample vendor > empty form.
  useEffect(() => {
    if (!c || sub) return;
    if (last) {
      setSub(structuredClone(last.inputs.sub));
      const ups: Partial<Record<DocSlot, Upload>> = {};
      for (const [slot, ref] of Object.entries(last.inputs.sub.documents) as [DocSlot, string][]) {
        const m = ref.match(/^(V\d{2})\/(.+)$/);
        if (m) ups[slot] = { kind: "sample", scenario: m[1], file: m[2] };
      }
      setUploads(ups);
      return;
    }
    if (c.scenario && !samples) return; // wait for sample data
    if (sample) {
      const ups: Partial<Record<DocSlot, Upload>> = {};
      for (const [slot, file] of Object.entries(sample.sub.documents) as [DocSlot, string][])
        ups[slot] = { kind: "sample", scenario: sample.id, file };
      setSub({ ...structuredClone(sample.sub), documents: {} });
      setUploads(ups);
    } else setSub(emptySub(c.invite.vendor_name, c.invite.vendor_email));
  }, [c, sub, last, sample, samples]);

  const required = useMemo(() => (c && sub ? requiredDocs(c.tier, sub, s.policy) : []), [c, sub, s.policy]);
  const slots = ALL_SLOTS.filter((x) => required.includes(x) || uploads[x]);
  const asks = isFix ? last!.decision.vendor_actions : [];
  const askSlots = new Set(
    isFix ? last!.checks.filter((k) => k.outcome === "fail" && k.severity === "vendor_fixable").flatMap((k) =>
      k.code === "DOC_MISSING" ? required.filter((r) => !last!.inputs.sub.documents[r]) : k.id.startsWith("doc_") ? [k.id.slice(4) as DocSlot] : [],
    ) : [],
  );

  if (!c) return <p>Case not found. It may have been cleared with “Reset demo”. <Link className="underline" href="/">Back to cases</Link></p>;
  if (!sub) return <p className="text-ink-3">Loading form…</p>;
  const status = caseStatus(c);
  if (last && !isFix)
    return (
      <Section title="Thanks, your details are with us">
        <p>This submission is already being handled. <Link className="underline" href={`/cases/${c.id}`}>See the case</Link></p>
      </Section>
    );

  const set = (path: string, v: string) =>
    setSub((old) => {
      const n = structuredClone(old!) as unknown as Record<string, Record<string, string>>;
      const [a, b] = path.split(".");
      if (b) n[a][b] = v;
      else (n as unknown as Record<string, string>)[a] = v;
      return n as unknown as Submission;
    });
  const F = (label: string, path: string, opts: { mono?: boolean; span?: boolean; placeholder?: string } = {}) => {
    const [a, b] = path.split(".");
    const val = (b ? (sub as unknown as Record<string, Record<string, string>>)[a]?.[b] : (sub as unknown as Record<string, string>)[a]) ?? "";
    return (
      <label className={opts.span ? "sm:col-span-2" : ""}>
        <span className="label">{label}</span>
        <input className={`field ${opts.mono ? "id" : ""}`} value={val} placeholder={opts.placeholder} onChange={(e) => set(path, e.target.value)} />
      </label>
    );
  };

  const submit = () => {
    const documents: Partial<Record<DocSlot, string>> = { ...sub.documents };
    for (const [slot, up] of Object.entries(uploads) as [DocSlot, Upload][]) documents[slot] = fileRef(up);
    pendingJobs.set(c.id, { sub: { ...sub, documents }, uploads, trigger: last ? "resubmission" : "submission" });
    router.push(`/cases/${c.id}?live=1`);
  };

  return (
    <div className="mx-auto max-w-[860px]">
      <div className="mb-5">
        <p className="text-[14px] text-ink-2">{BUYER_COMPANY} has invited you to become a vendor</p>
        <h1 className="text-[26px] font-extrabold leading-tight tracking-tight">{isFix ? "A few things to fix" : "Your business details"}</h1>
        {sample && !isFix && (
          <p className="mt-2 rounded border border-dashed border-rule-strong bg-sheet px-3 py-2 text-[14px] text-ink-2">
            Sample vendor: <b className="text-ink">{SAMPLE_BLURB[sample.id]?.name}</b>. The form and documents are already filled in. Change anything you like, then submit.
          </p>
        )}
      </div>

      {isFix && (
        <div className="mb-5 rounded-md border px-4 py-3" style={{ borderColor: "var(--wait)", background: "var(--wait-bg)" }}>
          <p className="font-semibold">We need {asks.length === 1 ? "one thing" : `${asks.length} things`} before we can approve you:</p>
          <ul className="mt-1 list-disc pl-5 text-[14px]">
            {asks.map((a) => (
              <li key={a.code}>{a.message}</li>
            ))}
          </ul>
          <p className="mt-1 text-[13px] text-ink-2">Everything else you sent is fine and has been kept.</p>
        </div>
      )}

      <div className="grid gap-5">
        {!isFix && (
          <>
            <Section title="Business">
              <div className="grid gap-4 sm:grid-cols-2">
                {F("Legal name (as on PAN / GST certificate)", "legal_name", { span: true })}
                {F("Trade name, if different", "trade_name")}
                <label>
                  <span className="label">Type of business</span>
                  <select className="field" value={sub.constitution} onChange={(e) => set("constitution", e.target.value)}>
                    {CONSTITUTIONS.map((x) => <option key={x}>{x}</option>)}
                  </select>
                </label>
                {F("Registered address", "address.line1", { span: true })}
                {F("City", "address.city")}
                {F("State", "address.state")}
                {F("PIN code", "address.pincode", { mono: true })}
              </div>
            </Section>
            <Section title="Tax registration">
              <div className="grid gap-4 sm:grid-cols-2">
                {F("GSTIN", "gstin", { mono: true, placeholder: "29ABCDE1234F1Z5" })}
                {F("PAN", "pan", { mono: true, placeholder: "ABCDE1234F" })}
                {required.includes("incorporation_certificate") && F("Company Identification Number (CIN)", "cin", { mono: true, span: true })}
              </div>
            </Section>
            <Section title="Bank account for payments">
              <div className="grid gap-4 sm:grid-cols-2">
                {F("Account holder name (as printed on cheque)", "bank.account_holder", { span: true })}
                {F("Account number", "bank.account_number", { mono: true })}
                {F("IFSC", "bank.ifsc", { mono: true, placeholder: "HDFC0001234" })}
                {F("Bank name", "bank.bank_name")}
              </div>
            </Section>
            <Section title="Contact">
              <div className="grid gap-4 sm:grid-cols-3">
                {F("Name", "contact.name")}
                {F("Email", "contact.email")}
                {F("Phone", "contact.phone")}
              </div>
            </Section>
          </>
        )}

        <Section title={isFix ? "Documents" : "Documents"}>
          <ul className="divide-y divide-rule">
            {slots.map((slot) => {
              const up = uploads[slot];
              const fix = sample?.fix_documents[slot];
              const flagged = askSlots.has(slot);
              if (isFix && !flagged) return null;
              return (
                <li key={slot} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-[200px] flex-1">
                    <div className="font-semibold">
                      {DOC_LABEL[slot]} {required.includes(slot) ? "" : <span className="font-normal text-ink-3">(optional)</span>}
                    </div>
                    <div className="text-[13px] text-ink-2">
                      {up ? (
                        <>
                          {up.kind === "sample" ? (
                            <a className="underline" href={sampleFileUrl(up.scenario, up.file)} target="_blank" rel="noreferrer">{up.file.split("/").pop()}</a>
                          ) : (
                            <a className="underline" href={up.previewUrl} target="_blank" rel="noreferrer">{up.file.name}</a>
                          )}
                          {flagged && <span className="ml-2 font-semibold text-wait">needs replacing</span>}
                        </>
                      ) : (
                        <span className={flagged ? "font-semibold text-wait" : ""}>Not uploaded</span>
                      )}
                    </div>
                  </div>
                  {isFix && fix && sample && (
                    <button
                      className="btn btn-quiet !py-1 text-[13px]"
                      onClick={() => setUploads({ ...uploads, [slot]: { kind: "sample", scenario: sample.id, file: fix } })}
                      disabled={up?.kind === "sample" && up.file === fix}
                    >
                      {up?.kind === "sample" && up.file === fix ? "Corrected file attached" : "Attach the correct sample file"}
                    </button>
                  )}
                  <label className="btn btn-quiet !py-1 text-[13px]">
                    {up ? "Replace…" : "Upload…"}
                    <input
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png"
                      className="sr-only"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) setUploads({ ...uploads, [slot]: { kind: "file", file, previewUrl: URL.createObjectURL(file) } });
                      }}
                    />
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-[13px] text-ink-3">PDF, JPG or PNG up to 8 MB. Photos from a phone are fine.</p>
        </Section>
      </div>

      <div className="mt-6 flex items-center justify-end gap-3">
        <span className="text-[13px] text-ink-3">{status === "INVITED" ? "We check everything automatically, usually in under a minute." : ""}</span>
        <button className="btn" onClick={submit}>
          {isFix ? "Send fixes" : "Submit for verification"}
        </button>
      </div>
    </div>
  );
}
