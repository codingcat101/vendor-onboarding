import { NextRequest, NextResponse } from "next/server";
import { askJson } from "@/lib/engine/ai";

export const maxDuration = 30;

type Kind = "request" | "reminder" | "escalation" | "approved" | "rejected" | "expired";
interface Body {
  kind: Kind;
  vendor_name: string;
  contact_name?: string;
  buyer: string;
  actions: string[];
  link: string;
  days_waiting?: number;
}

const BUYER_COMPANY = "Northwind Retail";

// Plain template: used when the AI is unavailable, and as the factual skeleton the AI must keep.
function template(b: Body): { subject: string; body: string } {
  const hi = `Hello ${b.contact_name || b.vendor_name},`;
  const list = b.actions.map((a) => `• ${a}`).join("\n");
  const sign = `\n\nThank you,\nVendor onboarding team, ${BUYER_COMPANY}`;
  switch (b.kind) {
    case "request":
      return {
        subject: `Action needed: ${b.actions.length === 1 ? "one item" : `${b.actions.length} items`} to complete your vendor registration`,
        body: `${hi}\n\nThank you for submitting your details. Before we can approve ${b.vendor_name} as a vendor, we need the following:\n\n${list}\n\nEverything else you sent is fine and has been kept. You can fix just these items here:\n${b.link}${sign}`,
      };
    case "reminder":
      return {
        subject: `Reminder: your vendor registration is waiting on ${b.actions.length === 1 ? "one item" : `${b.actions.length} items`}`,
        body: `${hi}\n\nA quick reminder that your registration with ${BUYER_COMPANY} is on hold until we receive:\n\n${list}\n\nIt only takes a minute:\n${b.link}${sign}`,
      };
    case "escalation":
      return {
        subject: `${b.vendor_name} has not responded for ${b.days_waiting} days`,
        body: `Hello ${b.buyer.split(" (")[0]},\n\n${b.vendor_name} has not responded to our request for ${b.days_waiting} days, including one reminder. Still outstanding:\n\n${list}\n\nIf you have another contact there, a quick call usually helps. The request closes automatically after 10 days.\n\nVendor onboarding`,
      };
    case "expired":
      return {
        subject: `Your vendor registration with ${BUYER_COMPANY} has been closed`,
        body: `${hi}\n\nWe did not receive the items below within 10 days, so we have closed this registration:\n\n${list}\n\nIf you would still like to work with us, please ask your contact at ${BUYER_COMPANY} for a new invitation.${sign}`,
      };
    case "approved":
      return {
        subject: `You're approved as a vendor with ${BUYER_COMPANY}`,
        body: `${hi}\n\nGood news: ${b.vendor_name} is now an approved vendor. Payments will go to the bank account you registered.${sign}`,
      };
    case "rejected":
      return {
        subject: `Your vendor registration with ${BUYER_COMPANY}`,
        body: `${hi}\n\nWe were not able to approve this registration because some of the details could not be verified. Your contact at ${BUYER_COMPANY} will get in touch.${sign}`,
      };
  }
}

const PROMPT = (b: Body, t: { subject: string; body: string }) => `Rewrite this email from a company's vendor onboarding team so it reads naturally and politely, in plain Indian business English.
Rules: keep every requested item and the link exactly as given; do not add new requests, promises, deadlines or facts; at most 120 words in the body; no exclamation marks.${b.kind === "rejected" ? " Do not mention fraud or which check failed." : ""}

SUBJECT: ${t.subject}
BODY:
${t.body}`;

export async function POST(req: NextRequest) {
  const b = (await req.json()) as Body;
  const t = template(b);
  if (["request", "reminder"].includes(b.kind)) {
    // Reminders get one quick attempt; the template is a perfectly good fallback.
    const ai = await askJson<{ subject: string; body: string }>(PROMPT(b, t), {
      type: "OBJECT", properties: { subject: { type: "STRING" }, body: { type: "STRING" } }, required: ["subject", "body"],
    }, b.kind === "reminder" ? 5000 : 7000, b.kind === "reminder" ? 1 : 2);
    // Accept the AI draft only if it kept the link (the one thing the vendor must be able to click).
    if (ai && ai.data.body.includes(b.link)) return NextResponse.json({ ...ai.data, by: "ai", model: ai.model });
  }
  return NextResponse.json({ ...t, by: "template" });
}
