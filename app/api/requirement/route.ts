import { NextRequest, NextResponse } from "next/server";
import { askJson } from "@/lib/engine/ai";
import { CATEGORIES, type Policy } from "@/lib/engine/policy";
import { LOOSEN_REASON, type RequirementDraft, loosensControls, parseRequirementByRules, summariseRequirement, validateRequirement } from "@/lib/engine/requirements";

export const maxDuration = 30;

// Procurement types a requirement in plain English. The AI turns it into structured fields;
// code validates them; the page shows a dry run; a person approves it.
export async function POST(req: NextRequest) {
  const { text, policy } = (await req.json()) as { text: string; policy: Policy };
  if (!text?.trim()) return NextResponse.json({ ok: false, reason: "Type a requirement first." });
  // Guardrail before any AI: a requirement may only add or raise checks.
  if (loosensControls(text)) return NextResponse.json({ ok: false, reason: LOOSEN_REASON, interpreted_by: "guardrail in code (before any AI)" });

  const ai = await askJson<{ supported: boolean; min_liability: number; currency: "USD" | "INR" | "GBP"; categories: string[]; countries: string[]; tiers: string[]; why: string }>(
    `Convert this vendor-onboarding requirement, written by a procurement team, into structured fields.
Requirement: """${text}"""
The only kind supported is: vendors must send a certificate of insurance with at least a given general-liability cover.
- supported: false if the sentence asks for anything else (another document, removing or relaxing a check, approving vendors).
- min_liability: the full amount as a number ("$1M" = 1000000, "₹1 crore" = 10000000, "₹50 lakh" = 5000000).
- currency: USD, INR or GBP.
- categories: which of these vendor categories it names, copied exactly, or [] if it doesn't limit by category: ${JSON.stringify(CATEGORIES)}. "IT vendors" means "IT services / data analytics".
- countries: any of "US", "IN", "GB" it limits to, or [].
- tiers: any of "LOW", "STANDARD", "STRATEGIC" it limits to, or [].
- why: one short sentence restating the rule.`,
    {
      type: "OBJECT",
      properties: {
        supported: { type: "BOOLEAN" }, min_liability: { type: "NUMBER" }, currency: { type: "STRING", enum: ["USD", "INR", "GBP"] },
        categories: { type: "ARRAY", items: { type: "STRING" } }, countries: { type: "ARRAY", items: { type: "STRING" } }, tiers: { type: "ARRAY", items: { type: "STRING" } }, why: { type: "STRING" },
      },
      required: ["supported", "min_liability", "currency", "categories", "countries", "tiers", "why"],
    },
  );

  let draft: RequirementDraft;
  let by: string;
  if (ai) {
    if (!ai.data.supported)
      return NextResponse.json({ ok: false, reason: "I can only turn insurance minimums into rules for now, e.g. “Require $1M liability coverage for all IT vendors”. Other changes are made by a person directly.", interpreted_by: `AI (${ai.model})` });
    const keep = <T extends string>(xs: string[], allowed: readonly T[]) => xs.filter((x): x is T => (allowed as readonly string[]).includes(x));
    const categories = keep(ai.data.categories, CATEGORIES);
    const countries = keep(ai.data.countries, ["US", "IN", "GB"] as const);
    const tiers = keep(ai.data.tiers, ["LOW", "STANDARD", "STRATEGIC"] as const);
    draft = {
      text: text.trim(), doc: "insurance_certificate", min_liability: Math.round(ai.data.min_liability), currency: ai.data.currency,
      applies_to: { ...(categories.length ? { categories } : {}), ...(countries.length ? { countries } : {}), ...(tiers.length ? { tiers } : {}) },
    };
    by = `AI (${ai.model})`;
  } else {
    const r = parseRequirementByRules(text);
    if ("error" in r) return NextResponse.json({ ok: false, reason: r.error, interpreted_by: "keyword rules (AI unavailable)" });
    draft = r;
    by = "keyword rules (AI unavailable)";
  }
  const v = validateRequirement(draft, policy);
  if (!v.ok) return NextResponse.json({ ok: false, reason: v.reason, interpreted_by: by });
  return NextResponse.json({ ok: true, draft, summary: summariseRequirement(draft), interpreted_by: by });
}
