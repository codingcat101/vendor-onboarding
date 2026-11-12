import fs from "fs";
import { readWithGemini } from "../lib/engine/extract";
(async () => {
  const bytes = fs.readFileSync("test-data/scenarios/V11/docs/insurance_certificate.pdf");
  for (const m of ["gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-3.1-flash-lite"]) {
    try { const r = await readWithGemini("insurance_certificate", "x.pdf", bytes, process.env.GEMINI_API_KEY!, m); console.log(m, JSON.stringify(r.fields)); } catch (e) { console.log(m, "ERR", (e as Error).message.slice(0, 120)); }
  }
})();
