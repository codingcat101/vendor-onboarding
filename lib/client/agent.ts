"use client";
// The follow-up agent: tells the vendor exactly what to fix, chases them, escalates, and closes
// the loop. Runs in the browser sandbox against the simulated clock.
import type { Case, CaseRun, OutboxMessage } from "./store";
import { caseName, caseStatus, useStore } from "./store";

type Store = ReturnType<typeof useStore>;

export const REMINDER_DAY = 2;
export const ESCALATE_DAY = 5;
export const EXPIRE_DAY = 10;
export const REVIEWER = "Anjali Rao (Finance)";

export const buyerEmail = (buyer: string) =>
  `${buyer.split(" (")[0].toLowerCase().replace(/\s+/g, ".")}@northwind.example`;

const fixLink = (c: Case) => `${typeof window !== "undefined" ? window.location.origin : ""}/vendor/${c.id}`;

async function draft(kind: OutboxMessage["kind"] | "expired", c: Case, actions: string[], days?: number) {
  try {
    const r = await fetch("/api/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind, vendor_name: caseName(c), contact_name: c.sub?.contact.name, buyer: c.invite.buyer, actions, link: fixLink(c), days_waiting: days,
      }),
    });
    return (await r.json()) as { subject: string; body: string; by: "ai" | "template"; model?: string };
  } catch {
    return { subject: "Update on your vendor registration", body: actions.join("\n"), by: "template" as const };
  }
}

/** After every decision: tell the right person. */
export async function notifyAfterRun(s: Store, c: Case, run: CaseRun) {
  const status = run.decision.status;
  const actions = run.decision.vendor_actions.map((a) => a.message);
  if (status === "PENDING_VENDOR") {
    const d = await draft("request", c, actions);
    s.addMessage({ case_id: c.id, to: c.sub?.contact.email ?? c.invite.vendor_email, subject: d.subject, body: d.body, kind: "request", drafted_by: d.by === "ai" ? `AI (${d.model})` : "template" });
    s.addEvent(c.id, { actor: "Follow-up agent", kind: "message", text: `Asked the vendor for ${actions.length === 1 ? "1 fix" : `${actions.length} fixes`} with a link to change only those items${d.by === "ai" ? " (message drafted by AI)" : ""}.` });
  } else if (status === "APPROVED") {
    const d = await draft("approved", c, []);
    s.addMessage({ case_id: c.id, to: c.sub?.contact.email ?? c.invite.vendor_email, subject: d.subject, body: d.body, kind: "approved", drafted_by: "template" });
  } else if (status === "REJECTED") {
    const d = await draft("rejected", c, []);
    s.addMessage({ case_id: c.id, to: c.sub?.contact.email ?? c.invite.vendor_email, subject: d.subject, body: d.body, kind: "rejected", drafted_by: "template" });
    s.addEvent(c.id, { actor: "Follow-up agent", kind: "message", text: "Told the vendor the registration could not be approved, without saying which check failed." });
  }
}

export function daysWaiting(c: Case, now: Date) {
  const last = c.runs.at(-1);
  if (!last) return 0;
  return Math.floor((now.getTime() - new Date(last.at).getTime()) / 86_400_000);
}

/** What the agent will do next for a case waiting on the vendor. */
export function nextFollowUp(c: Case, now: Date): { day: number; what: string } | null {
  if (caseStatus(c) !== "PENDING_VENDOR") return null;
  const since = c.runs.at(-1)!.at;
  const done = (k: string) => c.events.some((e) => e.kind === k && e.at >= since);
  if (!done("reminder")) return { day: REMINDER_DAY, what: "Reminder to vendor" };
  if (!done("escalation")) return { day: ESCALATE_DAY, what: "Escalate to buyer" };
  return { day: EXPIRE_DAY, what: "Close as expired" };
}

let running = false;
let again = false;
/** Always the latest store, so a queued tick sees state written by the previous one. */
export const latestStore: { current: Store | null } = { current: null };
const fresh = (id: string) => latestStore.current?.getCase(id);

/** Called whenever the clock moves. Idempotent: each step happens once per waiting period.
 *  If time moves while a tick is still drafting messages, the tick runs again afterwards. */
export async function agentTick(s0: Store) {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      await tickOnce(latestStore.current ?? s0);
    } while (again);
  } finally {
    running = false;
  }
}

async function tickOnce(s: Store) {
  {
    const now = s.now();
    // All waiting cases are handled in parallel, so one slow draft never holds up the others.
    await Promise.all(s.cases.map(async (c0) => {
      const c = fresh(c0.id) ?? c0;
      if (caseStatus(c) !== "PENDING_VENDOR") return;
      const last = c.runs.at(-1)!;
      const days = daysWaiting(c, now);
      const actions = last.decision.vendor_actions.map((a) => a.message);
      const done = (k: string) => (fresh(c.id) ?? c).events.some((e) => e.kind === k && e.at >= last.at);

      if (days >= REMINDER_DAY && !done("reminder")) {
        const d = await draft("reminder", c, actions);
        s.addMessage({ case_id: c.id, to: c.sub?.contact.email ?? c.invite.vendor_email, subject: d.subject, body: d.body, kind: "reminder", drafted_by: d.by === "ai" ? `AI (${d.model})` : "template" });
        s.addEvent(c.id, { actor: "Follow-up agent", kind: "reminder", text: `No reply after ${days} days. Sent a reminder.` });
      }
      if (days >= ESCALATE_DAY && !done("escalation")) {
        const d = await draft("escalation", c, actions, days);
        s.addMessage({ case_id: c.id, to: buyerEmail(c.invite.buyer), subject: d.subject, body: d.body, kind: "escalation", drafted_by: "template" });
        s.addEvent(c.id, { actor: "Follow-up agent", kind: "escalation", text: `No reply after ${days} days. Escalated to ${c.invite.buyer.split(" (")[0]}, who invited them.` });
      }
      if (days >= EXPIRE_DAY && !c.expired_at) {
        const d = await draft("expired", c, actions);
        s.addMessage({ case_id: c.id, to: c.sub?.contact.email ?? c.invite.vendor_email, subject: d.subject, body: d.body, kind: "rejected", drafted_by: "template" });
        s.updateCase(c.id, (old) => ({ ...old, expired_at: now.toISOString() }));
        s.addEvent(c.id, { actor: "Follow-up agent", kind: "expiry", text: `No reply after ${days} days. Closed the request and told the vendor how to start again.` });
      }
    }));
  }
}
