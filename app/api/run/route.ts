import { NextRequest, NextResponse } from "next/server";
import { diffInputs, runOnboarding } from "@/lib/engine/engine";
import { loadMaster } from "@/lib/engine/fixtures";
import type { Policy } from "@/lib/engine/policy";
import type { DocSlot, ExistingVendor, ExtractedDoc, Invite, RunResult, Submission } from "@/lib/engine/types";

interface Body {
  sub: Submission;
  invite: Invite;
  docs: Partial<Record<DocSlot, ExtractedDoc>>;
  policy: Policy;
  /** Vendors approved in this visitor's sandbox, so later duplicates are caught. */
  extra_master?: ExistingVendor[];
  previous?: { run: RunResult; sub: Submission; docs: Partial<Record<DocSlot, ExtractedDoc>> };
}

// Runs every check and returns the decision. Pure: no state is stored on the server.
export async function POST(req: NextRequest) {
  const b = (await req.json()) as Body;
  const master = [...loadMaster(), ...(b.extra_master ?? [])];
  let changed: string[] | undefined;
  if (b.previous) {
    changed = diffInputs({ sub: b.previous.sub, docs: b.previous.docs }, { sub: b.sub, docs: b.docs });
    if (b.previous.run.policy_version !== b.policy.version) changed.push("policy");
  }
  const result = runOnboarding({ sub: b.sub, invite: b.invite, docs: b.docs, master, policy: b.policy, previous: b.previous?.run, changed });
  return NextResponse.json({ ...result, changed });
}
