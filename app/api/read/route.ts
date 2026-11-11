import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { cachedReading, readDocument } from "@/lib/engine/extract";
import { loadScenarios, scenarioFile, truthReading } from "@/lib/engine/fixtures";
import type { DocSlot } from "@/lib/engine/types";

export const maxDuration = 60;
const SLOTS = ["gst_certificate", "pan_card", "w9_form", "cancelled_cheque", "incorporation_certificate", "security_certificate"];
const MAX_BYTES = 8 * 1024 * 1024;

// Reads one document with AI. Accepts either a sample file reference (JSON) or an uploaded file (multipart).
export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  let slot: string, file: string, bytes: Buffer, scenario: string | undefined;
  let preferRecorded = false;

  if (req.headers.get("content-type")?.includes("multipart/form-data")) {
    const form = await req.formData();
    const f = form.get("file");
    slot = String(form.get("slot"));
    if (!(f instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
    if (f.size > MAX_BYTES) return NextResponse.json({ error: "File is larger than 8 MB" }, { status: 413 });
    if (!/\.(pdf|jpe?g|png)$/i.test(f.name)) return NextResponse.json({ error: "Upload a PDF, JPG or PNG" }, { status: 415 });
    file = `upload/${f.name}`;
    bytes = Buffer.from(await f.arrayBuffer());
  } else {
    const body = await req.json();
    slot = body.slot;
    scenario = body.scenario;
    file = body.file;
    preferRecorded = !!body.prefer_recorded;
    if (!/^V\d{2}$/.test(scenario ?? "") || !/^(docs|fix)\/[a-z0-9_]+\.(pdf|jpg)$/.test(file))
      return NextResponse.json({ error: "Unknown sample file" }, { status: 400 });
    bytes = fs.readFileSync(scenarioFile(scenario!, file));
  }
  if (!SLOTS.includes(slot)) return NextResponse.json({ error: "Unknown document slot" }, { status: 400 });

  // Bulk demo loading uses the AI readings recorded earlier, to save the daily AI quota for live runs.
  if (preferRecorded && scenario) {
    const r = cachedReading(scenario, slot as DocSlot, file);
    if (r) return NextResponse.json(r);
  }

  // Development only: READER=reference uses the known correct values of sample documents (labelled on screen).
  if (process.env.READER === "reference" && scenario) {
    const sc = loadScenarios().find((x) => x.id === scenario);
    if (sc?.expected.document_truth[file]) {
      await new Promise((r) => setTimeout(r, 600 + Math.random() * 900));
      return NextResponse.json(truthReading(sc, slot as DocSlot, file));
    }
  }

  const reading = await readDocument({ scenario, slot: slot as DocSlot, file, bytes, apiKey });
  return NextResponse.json(reading);
}
