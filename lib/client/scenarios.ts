"use client";
import { useEffect, useState } from "react";
import type { DocSlot, Invite, Submission } from "@/lib/engine/types";

export interface SampleScenario {
  id: string;
  title: string;
  invite: Invite;
  sub: Submission;
  fix_documents: Partial<Record<DocSlot, string>>;
  fix_fields: Record<string, string>;
  expected_status: string;
}

/** Plain-language one-liners for the sample list. */
export const SAMPLE_BLURB: Record<string, { name: string; what: string }> = {
  V01: { name: "Kaveri Packaging", what: "Clean submission, everything matches" },
  V02: { name: "Nimbus Cloud Analytics", what: "Clean, but gets data access, so a person must sign off" },
  V03: { name: "Ganga Office Supplies", what: "Uploads an invoice instead of the GST certificate" },
  V04: { name: "Sharma Trading Co.", what: "Bank account is in “Sharma Traders”" },
  V05: { name: "Gupta Trading Company", what: "Same pattern as Sharma; cheque is a phone photo" },
  V06: { name: "Apex Facility Services", what: "Bank account already belongs to another vendor" },
  V07: { name: "Orion Engineering Works", what: "GSTIN is real but registered to someone else" },
  V08: { name: "Lotus Print House", what: "Cancelled cheque missing; vendor goes quiet" },
  V09: { name: "Thames Precision Tools (UK)", what: "Enters an Indian GSTIN as its UK tax ID" },
};

let cache: SampleScenario[] | null = null;

export function useScenarios() {
  const [list, setList] = useState<SampleScenario[] | null>(cache);
  useEffect(() => {
    if (cache) return;
    fetch("/api/scenarios")
      .then((r) => r.json())
      .then((j) => {
        cache = j;
        setList(j);
      });
  }, []);
  return list;
}

export const sampleFileUrl = (scenario: string, file: string) => `/api/file?scenario=${scenario}&path=${encodeURIComponent(file)}`;
