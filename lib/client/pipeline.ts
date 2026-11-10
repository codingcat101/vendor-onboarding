"use client";
// Runs a submission: reads each document with AI (only the ones that changed), then runs the checks.
import type { Policy } from "@/lib/engine/policy";
import type { DocSlot, ExistingVendor, Submission } from "@/lib/engine/types";
import type { Case, CaseRun, Reading } from "./store";

export type Upload =
  | { kind: "sample"; scenario: string; file: string }
  | { kind: "file"; file: File; previewUrl: string };

/** Uploaded files live only in memory (for previews in this session). */
export const uploadPreviews = new Map<string, string>();

export type Progress =
  | { phase: "reading"; slot: DocSlot; state: "start" | "reused" | "done"; reading?: Reading }
  | { phase: "checking" };

async function readOne(slot: DocSlot, up: Upload, preferRecorded = false): Promise<Reading> {
  let res: Response;
  if (up.kind === "sample") {
    res = await fetch("/api/read", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot, scenario: up.scenario, file: up.file, prefer_recorded: preferRecorded }),
    });
  } else {
    const fd = new FormData();
    fd.set("slot", slot);
    fd.set("file", up.file);
    res = await fetch("/api/read", { method: "POST", body: fd });
  }
  const j = await res.json();
  if (!res.ok) return { slot, file: up.kind === "sample" ? up.file : up.file.name, doc_type: "other", fields: {}, confidence: 0, source: "ai", error: j.error };
  return j;
}

export const fileRef = (up: Upload) => (up.kind === "sample" ? `${up.scenario}/${up.file}` : `upload/${up.file.name}/${up.file.size}`);

export async function processSubmission(opts: {
  c: Case;
  sub: Submission;
  uploads: Partial<Record<DocSlot, Upload>>;
  policy: Policy;
  extraMaster: ExistingVendor[];
  onProgress: (p: Progress) => void;
  trigger: CaseRun["trigger"];
  at: string;
  preferRecorded?: boolean;
}): Promise<CaseRun> {
  const { c, sub, uploads, policy, extraMaster, onProgress, trigger, at, preferRecorded } = opts;
  const prev = c.runs.at(-1);

  // 1. Read documents — reuse earlier readings for files that did not change.
  const docs: Partial<Record<DocSlot, Reading>> = {};
  // Files kept from the previous submission that we can't re-send (e.g. the vendor's own uploads): reuse the reading.
  for (const [slot, ref] of Object.entries(sub.documents) as [DocSlot, string][]) {
    if (!uploads[slot] && c.readings[slot] && prev?.inputs.sub.documents[slot] === ref) {
      docs[slot] = c.readings[slot];
      onProgress({ phase: "reading", slot, state: "reused", reading: c.readings[slot] });
    }
  }
  await Promise.all(
    (Object.entries(uploads) as [DocSlot, Upload][]).map(async ([slot, up]) => {
      const ref = fileRef(up);
      const old = c.readings[slot];
      if (old && sub.documents[slot] === ref && prev?.inputs.sub.documents[slot] === ref) {
        docs[slot] = old;
        onProgress({ phase: "reading", slot, state: "reused", reading: old });
        return;
      }
      if (up.kind === "file") uploadPreviews.set(ref, up.previewUrl);
      onProgress({ phase: "reading", slot, state: "start" });
      const r = await readOne(slot, up, preferRecorded);
      docs[slot] = r;
      onProgress({ phase: "reading", slot, state: "done", reading: r });
    }),
  );

  // 2. Run the checks (server). Incremental if there is a previous run.
  onProgress({ phase: "checking" });
  const res = await fetch("/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sub, invite: c.invite, docs, policy, extra_master: extraMaster.filter((v) => v.vendor_id !== c.id), as_of: at,
      previous: prev ? { run: prev, sub: prev.inputs.sub, docs: prev.inputs.docs } : undefined,
    }),
  });
  if (!res.ok) throw new Error(`Checks failed to run (${res.status})`);
  const run = await res.json();
  return { ...run, at, trigger, inputs: { sub, docs } };
}

/** Re-run the checks with the same inputs, e.g. after the policy changed. No AI calls. */
export async function rerunWithPolicy(c: Case, policy: Policy, extraMaster: ExistingVendor[], at: string): Promise<CaseRun | null> {
  const prev = c.runs.at(-1);
  if (!prev) return null;
  const res = await fetch("/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sub: prev.inputs.sub, invite: c.invite, docs: prev.inputs.docs, policy, extra_master: extraMaster.filter((v) => v.vendor_id !== c.id), as_of: at,
      previous: { run: prev, sub: prev.inputs.sub, docs: prev.inputs.docs },
    }),
  });
  if (!res.ok) return null;
  const run = await res.json();
  return { ...run, at, trigger: "policy_change", inputs: prev.inputs };
}
