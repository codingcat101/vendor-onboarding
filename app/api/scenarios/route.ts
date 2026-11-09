import { NextResponse } from "next/server";
import { loadScenarios } from "@/lib/engine/fixtures";

// The sample vendors a demo user can play through.
export async function GET() {
  const list = loadScenarios().map((s) => ({
    id: s.id, title: s.title, invite: s.invite, sub: s.sub,
    fix_documents: s.expected.fix_documents, expected_status: s.expected.status,
  }));
  return NextResponse.json(list);
}
