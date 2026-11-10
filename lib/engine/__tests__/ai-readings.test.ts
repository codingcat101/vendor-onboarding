// End to end with the REAL AI readings recorded by scripts/eval-readings.ts (not ground truth).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runOnboarding } from "../engine";
import { cachedReading } from "../extract";
import { loadMaster, loadScenarios } from "../fixtures";
import { DEFAULT_POLICY } from "../policy";
import type { DocSlot, ExtractedDoc } from "../types";

const hasReadings = fs.existsSync(path.join(process.cwd(), "test-data", "readings", "V01"));

describe.skipIf(!hasReadings)("decisions from real AI readings", () => {
  const master = loadMaster();
  for (const s of loadScenarios()) {
    it(`${s.id} → ${s.expected.status}`, () => {
      const docs: Partial<Record<DocSlot, ExtractedDoc>> = {};
      for (const [slot, file] of Object.entries(s.sub.documents) as [DocSlot, string][]) docs[slot] = cachedReading(s.id, slot, file)!;
      const r = runOnboarding({ sub: s.sub, invite: s.invite, docs, master, policy: DEFAULT_POLICY, asOf: "2026-11-10" });
      expect(r.decision.status).toBe(s.expected.status);
      for (const code of s.expected.reasons) expect(r.decision.reasons.map((x) => x.code)).toContain(code);
    });
  }
});
