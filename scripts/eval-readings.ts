// Measures how accurately the AI reads the sample documents, and records each reading as a backup
// for the live demo.   Run:  GEMINI_API_KEY=... npx tsx scripts/eval-readings.ts
import fs from "node:fs";
import path from "node:path";
import { MODELS, readLive, saveReading } from "../lib/engine/extract";
import { loadScenarios, scenarioFile } from "../lib/engine/fixtures";
import { normaliseName } from "../lib/engine/names";
import type { DocSlot } from "../lib/engine/types";

const key = process.env.GEMINI_API_KEY!;
const ID = new Set(["gstin", "pan", "account_number", "ifsc", "cin"]);
const norm = (k: string, v = "") => (ID.has(k) ? v.toUpperCase().replace(/[^A-Z0-9]/g, "") : normaliseName(v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 2) throw e;
      console.log(`  retry: ${(e as Error).message.slice(0, 80)}`);
      await sleep(5000 * (i + 1));
    }
  }
}

(async () => {
  const rows: { model?: string; doc: string; type_ok: boolean; got_type: string; fields: number; correct: number; misses: string[]; conf: number; ms: number }[] = [];
  for (const s of loadScenarios()) {
    for (const [file, truth] of Object.entries(s.expected.document_truth)) {
      const slot = (Object.entries({ ...s.sub.documents, ...s.expected.fix_documents }).find(([, f]) => f === file)?.[0] ?? "gst_certificate") as DocSlot;
      const bytes = fs.readFileSync(scenarioFile(s.id, file));
      const r = await withRetry(async () => {
        const { reading, errors } = await readLive(slot, file, bytes, key);
        if (!reading) throw new Error(errors.join("; "));
        return reading;
      });
      saveReading(s.id, r);
      const { doc_type, ...fields } = truth;
      const misses: string[] = [];
      let correct = 0;
      for (const [k, v] of Object.entries(fields)) {
        if (norm(k, r.fields[k]) === norm(k, v)) correct++;
        else misses.push(`${k}: expected "${v}", read "${r.fields[k] ?? ""}"`);
      }
      rows.push({ model: r.model, doc: `${s.id}/${file}`, type_ok: r.doc_type === doc_type, got_type: r.doc_type, fields: Object.keys(fields).length, correct, misses, conf: r.confidence, ms: r.ms ?? 0 });
      const last = rows.at(-1)!;
      console.log(`${last.doc.padEnd(42)} type ${last.type_ok ? "ok " : "BAD"} (${r.doc_type}) fields ${correct}/${last.fields} conf ${r.confidence.toFixed(2)} ${(last.ms / 1000).toFixed(1)}s ${r.model} ${misses.join(" | ")}`);
      await sleep(1500); // stay inside free-tier rate limits
    }
  }
  const f = rows.reduce((a, r) => a + r.fields, 0);
  const c = rows.reduce((a, r) => a + r.correct, 0);
  const t = rows.filter((r) => r.type_ok).length;
  const avg = rows.reduce((a, r) => a + r.ms, 0) / rows.length / 1000;
  const summary = { documents: rows.length, doc_type_accuracy: t / rows.length, field_accuracy: c / f, fields_total: f, fields_correct: c, avg_seconds: avg, models_tried: MODELS, run_at: new Date().toISOString(), rows };
  fs.writeFileSync(path.join(process.cwd(), "test-data", "readings", "accuracy.json"), JSON.stringify(summary, null, 2));
  console.log(`\nDocument type: ${t}/${rows.length}   Fields: ${c}/${f} (${((100 * c) / f).toFixed(1)}%)   Avg ${avg.toFixed(1)}s per document`);
})();
