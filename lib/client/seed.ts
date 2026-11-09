"use client";
// Plays all sample vendors in one go, so the dashboard and queues have realistic content.
import { notifyAfterRun } from "./agent";
import { Upload, fileRef, processSubmission } from "./pipeline";
import type { SampleScenario } from "./scenarios";
import { STATUS_LABEL_PLAIN, useStore } from "./store";
import type { DocSlot } from "@/lib/engine/types";

export async function runAllSamples(s: ReturnType<typeof useStore>, samples: SampleScenario[], onStep: (name: string) => void) {
  for (const sc of samples) {
    onStep(sc.sub.trade_name || sc.sub.legal_name);
    const c = s.createCase({ ...sc.invite, vendor_name: sc.sub.trade_name || sc.sub.legal_name, vendor_email: sc.sub.contact.email }, sc.id);
    const uploads: Partial<Record<DocSlot, Upload>> = {};
    const documents: Partial<Record<DocSlot, string>> = {};
    for (const [slot, file] of Object.entries(sc.sub.documents) as [DocSlot, string][]) {
      uploads[slot] = { kind: "sample", scenario: sc.id, file };
      documents[slot] = fileRef(uploads[slot]!);
    }
    const sub = { ...sc.sub, documents };
    s.addEvent(c.id, { actor: c.invite.vendor_name, kind: "submit", text: `Vendor submitted details and ${Object.keys(documents).length} documents` });
    const run = await processSubmission({
      c, sub, uploads, policy: s.policy, extraMaster: s.approvedVendors(), trigger: "submission", at: s.now().toISOString(),
      onProgress: () => {}, preferRecorded: true,
    });
    s.updateCase(c.id, (old) => ({
      ...old, sub, readings: run.inputs.docs, runs: [...old.runs, run],
      events: [...old.events, { at: run.at, actor: "Process", kind: "decision", text: `decided: ${STATUS_LABEL_PLAIN[run.decision.status]}. ${run.decision.summary}` }],
    }));
    await notifyAfterRun(s, { ...c, sub }, run);
  }
}
