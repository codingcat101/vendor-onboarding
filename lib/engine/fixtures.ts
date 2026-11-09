// Loads the bundled test scenarios (server-side only).
import fs from "node:fs";
import path from "node:path";
import type { DocSlot, ExistingVendor, ExtractedDoc, Invite, Submission } from "./types";

const ROOT = process.cwd();
const TD = path.join(ROOT, "test-data");

export interface Scenario {
  id: string;
  title: string;
  invite: Invite;
  sub: Submission;
  expected: {
    tier: string;
    status: string;
    reasons: string[];
    fix_documents: Partial<Record<DocSlot, string>>;
    document_truth: Record<string, Record<string, string>>;
    [k: string]: unknown;
  };
}

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));

export function loadMaster(): ExistingVendor[] {
  return readJson(path.join(ROOT, "data", "vendor_master.json"));
}

export function loadScenarios(): Scenario[] {
  const expected = readJson(path.join(TD, "expected.json"));
  return Object.keys(expected).map((id) => {
    const dir = path.join(TD, "scenarios", id);
    return { id, title: expected[id].title, invite: readJson(path.join(dir, "invite.json")), sub: readJson(path.join(dir, "submission.json")), expected: expected[id] };
  });
}

export function scenarioFile(id: string, rel: string) {
  return path.join(TD, "scenarios", id, rel);
}

/** A "perfect reader": document fields straight from ground truth. Used for logic tests. */
export function truthReading(s: Scenario, slot: DocSlot, file: string): ExtractedDoc {
  const { doc_type, ...fields } = s.expected.document_truth[file];
  return { slot, file, doc_type, fields, confidence: 0.95, source: "ground_truth" };
}

export function truthReadings(s: Scenario, documents = s.sub.documents) {
  const out: Partial<Record<DocSlot, ExtractedDoc>> = {};
  for (const [slot, file] of Object.entries(documents) as [DocSlot, string][]) out[slot] = truthReading(s, slot, file);
  return out;
}
