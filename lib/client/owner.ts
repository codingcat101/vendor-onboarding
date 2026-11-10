"use client";
// Who acts next on a case, and what they need to do. Every case always has exactly one next owner.
import { ESCALATE_DAY, REVIEWER, daysWaiting } from "./agent";
import { Case, caseStatus } from "./store";

export type Owner = "Vendor" | "Reviewer" | "Buyer" | "Finance";

export interface NextStep {
  owner: Owner;
  who: string;
  action: string;
  open: number; // open items on the case
}

const first = (s: string) => s.split(" (")[0];

export function nextStep(c: Case, now: Date): NextStep {
  const status = caseStatus(c);
  const run = c.runs.at(-1);
  switch (status) {
    case "INVITED":
      return { owner: "Vendor", who: c.invite.vendor_name, action: "Submit details and documents", open: 0 };
    case "PENDING_VENDOR": {
      const n = run!.decision.vendor_actions.length;
      const escalated = c.events.some((e) => e.kind === "escalation" && e.at >= run!.at);
      if (escalated && daysWaiting(c, now) >= ESCALATE_DAY)
        return { owner: "Buyer", who: first(c.invite.buyer), action: "Call the vendor; they haven't replied", open: n };
      return { owner: "Vendor", who: c.invite.vendor_name, action: n === 1 ? "Fix 1 item" : `Fix ${n} items`, open: n };
    }
    case "PENDING_INTERNAL": {
      const reasons = run!.decision.reasons;
      const signoff = reasons.every((r) => r.code === "STRATEGIC_SIGNOFF_REQUIRED");
      return { owner: "Reviewer", who: first(REVIEWER), action: signoff ? "Sign off (strategic vendor)" : `Decide ${reasons.length === 1 ? "1 item" : `${reasons.length} items`}`, open: reasons.length };
    }
    case "APPROVED":
      return { owner: "Finance", who: "Finance", action: "Confirm bank details by call-back before the first payment", open: 0 };
    case "REJECTED":
      return { owner: "Buyer", who: first(c.invite.buyer), action: "Tell the requester and choose another vendor", open: run?.decision.reasons.length ?? 0 };
    case "EXPIRED":
      return { owner: "Buyer", who: first(c.invite.buyer), action: "Re-invite the vendor or close the request", open: run?.decision.vendor_actions.length ?? 0 };
  }
}

export const OWNER_COLOR: Record<Owner, string> = {
  Vendor: "var(--wait)",
  Reviewer: "var(--review)",
  Buyer: "var(--ink-2)",
  Finance: "var(--approve)",
};
