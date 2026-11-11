// AI document reading. The model is shown ONLY the document — never the form — so it reads
// what is actually there instead of "confirming" what the vendor typed. It returns structured
// JSON; every decision is then made by the plain-code checks in checks.ts.
//
// Order of preference:  live AI reading  →  cached AI reading (recorded from an earlier real run)
// If neither is available the document is treated as unreadable (asks the vendor for a clearer copy).
import fs from "node:fs";
import path from "node:path";
import type { DocSlot, ExtractedDoc } from "./types";

/** Tried in order. If one is slow or overloaded, the next one reads the document. */
export const MODELS = (process.env.GEMINI_MODELS || "gemini-3.6-flash,gemini-3-flash-preview,gemini-3.1-flash-lite").split(",").map((m) => m.trim());
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 25000);

const PROMPT = `You are reading ONE document uploaded during vendor onboarding (vendors are mostly in India, some abroad).
1. Decide what the document actually is. doc_type must be one of:
   gst_certificate, pan_card, w9_form (US IRS Form W-9), cancelled_cheque, incorporation_certificate, security_certificate (an ISO 27001 certificate or SOC 2 report), invoice, bank_letter, purchase_order, aadhaar_card, other.
   Judge by content, not by any file name.
2. Extract ONLY the fields that are visibly printed (leave others as empty strings). Copy values exactly; do not correct or guess.
   - gst_certificate: gstin, legal_name, trade_name, state
   - pan_card: pan, name
   - w9_form: legal_name (line 1, name of entity/individual), business_name (line 2, if any), entity_type (the federal tax classification box that is checked, e.g. "LLC (C corporation)"), tin (the EIN or SSN exactly as printed), signature_date (as YYYY-MM-DD; empty if the form is not signed)
   - cancelled_cheque / bank_letter: account_number (an IBAN if shown), ifsc (or US routing number / UK sort code), account_holder, bank_name
   - incorporation_certificate: cin, legal_name, pan
   - security_certificate: holder (organisation it is issued to), standard (e.g. "ISO/IEC 27001:2022" or "SOC 2 Type II"), certificate_number, issuer, valid_until (as YYYY-MM-DD)
   - invoice: gstin
3. confidence: 0..1, your confidence that doc_type AND the key identifiers are read correctly. Lower it for blur, skew, glare or cut-off text.
4. notes: one short sentence on anything unusual (e.g. "photo is skewed", "looks edited", "document is an invoice").`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    doc_type: { type: "STRING" },
    fields: {
      type: "OBJECT",
      properties: Object.fromEntries(
        ["gstin", "legal_name", "trade_name", "state", "pan", "name", "account_number", "ifsc", "account_holder", "bank_name", "cin", "holder", "standard", "certificate_number", "issuer", "valid_until", "business_name", "entity_type", "tin", "signature_date"].map(
          (k) => [k, { type: "STRING" }],
        ),
      ),
    },
    confidence: { type: "NUMBER" },
    notes: { type: "STRING" },
  },
  required: ["doc_type", "fields", "confidence"],
};

export type Reading = ExtractedDoc & { notes?: string; ms?: number; error?: string; model?: string };

function mimeOf(file: string) {
  return file.toLowerCase().endsWith(".pdf") ? "application/pdf" : file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
}

export async function readWithGemini(slot: DocSlot, file: string, bytes: Buffer, apiKey: string, model = MODELS[0]): Promise<Reading> {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    signal: ctl.signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ inline_data: { mime_type: mimeOf(file), data: bytes.toString("base64") } }, { text: PROMPT }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA },
    }),
  });
  if (!res.ok) {
    clearTimeout(timer);
    throw new Error(`${model} ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  const json = await res.json();
  clearTimeout(timer);
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  const parsed = JSON.parse(text);
  const fields = Object.fromEntries(Object.entries(parsed.fields ?? {}).filter(([, v]) => typeof v === "string" && v.trim())) as Record<string, string>;
  return {
    slot, file, doc_type: parsed.doc_type, fields, confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    source: "ai", notes: parsed.notes, ms: Date.now() - t0, model,
  };
}

const CACHE_DIR = path.join(process.cwd(), "test-data", "readings");
const cacheKey = (scenario: string, file: string) => path.join(CACHE_DIR, scenario, file.replace(/[\\/]/g, "__") + ".json");

export function cachedReading(scenario: string, slot: DocSlot, file: string): Reading | null {
  try {
    const r = JSON.parse(fs.readFileSync(cacheKey(scenario, file), "utf8"));
    return { ...r, slot, source: "cache" };
  } catch {
    return null;
  }
}

export function saveReading(scenario: string, r: Reading) {
  const p = cacheKey(scenario, r.file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(r, null, 2));
}

/** Try each model in turn. */
export async function readLive(slot: DocSlot, file: string, bytes: Buffer, apiKey: string) {
  const errors: string[] = [];
  for (const model of MODELS) {
    try {
      const r = await readWithGemini(slot, file, bytes, apiKey, model);
      if (errors.length) r.notes = [`${MODELS[0]} was busy, read by ${model}`, r.notes].filter(Boolean).join(". ");
      return { reading: r, errors };
    } catch (e) {
      errors.push((e as Error).name === "AbortError" ? `${model} timed out` : (e as Error).message.split(":")[0]);
    }
  }
  return { reading: null, errors };
}

/** Read one document: live AI first, then the recorded reading, else "unreadable". */
export async function readDocument(opts: {
  scenario?: string; slot: DocSlot; file: string; bytes: Buffer; apiKey?: string;
}): Promise<Reading> {
  const { scenario, slot, file, bytes, apiKey } = opts;
  if (apiKey) {
    const { reading, errors } = await readLive(slot, file, bytes, apiKey);
    if (reading) return reading;
    const cached = scenario ? cachedReading(scenario, slot, file) : null;
    if (cached) return { ...cached, notes: `Live AI unavailable (${errors.join("; ")}). Used the AI reading recorded earlier.` };
    return { slot, file, doc_type: "other", fields: {}, confidence: 0, source: "ai", error: `AI could not read the document right now (${errors.join("; ")})` };
  }
  const cached = scenario ? cachedReading(scenario, slot, file) : null;
  if (cached) return cached;
  return { slot, file, doc_type: "other", fields: {}, confidence: 0, source: "ai", error: "No AI key configured and no recorded reading" };
}
