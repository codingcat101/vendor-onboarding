import { NextRequest, NextResponse } from "next/server";
import { askJson } from "@/lib/engine/ai";
import { canTeach, interpretNoteByRules, namesFromCheck, proposeNameRule } from "@/lib/engine/teach";
import type { CheckResult } from "@/lib/engine/types";

export const maxDuration = 30;

// A reviewer approved a case and explained why. Propose a rule for similar cases (a person still approves it).
export async function POST(req: NextRequest) {
  const { checks, note, constitution } = (await req.json()) as { checks: CheckResult[]; note: string; constitution: string };
  const t = canTeach(checks);
  if (!t.ok) return NextResponse.json({ ok: false, reason: t.reason });
  const names = namesFromCheck(t.check);
  if (!names) return NextResponse.json({ ok: false, reason: "Could not find the two names to compare." });

  // The AI only interprets the reviewer's words. Code builds and validates the rule.
  const ai = await askJson<{ generalise: boolean; scope: "this_business_type" | "all_businesses"; why: string }>(
    `A reviewer approved a vendor whose bank account / document name ("${names[0]}") was close to, but not the same as, the registered business name ("${names[1]}"). The business is a ${constitution}.
Reviewer's note: """${note}"""
Decide: does the note describe a general pattern that should apply to similar future vendors (generalise=true), or a one-off judgement about this vendor, e.g. they phoned or checked something specific (generalise=false)?
scope: "this_business_type" if the note limits it to ${constitution}s or doesn't say; "all_businesses" only if the note clearly says it applies to any kind of business.
why: one short sentence.`,
    { type: "OBJECT", properties: { generalise: { type: "BOOLEAN" }, scope: { type: "STRING", enum: ["this_business_type", "all_businesses"] }, why: { type: "STRING" } }, required: ["generalise", "scope", "why"] },
  );
  const typeKey = /proprietor/i.test(constitution) ? "proprietor" : constitution.toLowerCase();
  const reading = ai
    ? { generalise: ai.data.generalise, scope: ai.data.scope === "all_businesses" ? undefined : [typeKey], why: ai.data.why, by: `AI (${ai.model})` }
    : { ...interpretNoteByRules(note, constitution), by: "keyword rules (AI unavailable)" };

  if (!reading.generalise) return NextResponse.json({ ok: false, one_off: true, reason: reading.why, interpreted_by: reading.by });
  const p = proposeNameRule(names[0], names[1], reading.scope);
  if (!p.ok) return NextResponse.json({ ok: false, reason: p.reason, interpreted_by: reading.by });
  return NextResponse.json({ ...p, why: reading.why, interpreted_by: reading.by, source_check: t.check.code });
}
