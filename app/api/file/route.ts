import fs from "node:fs";
import { NextRequest } from "next/server";
import { scenarioFile } from "@/lib/engine/fixtures";

// Serves a sample document for preview. Only files inside a scenario's docs/ or fix/ folder.
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("scenario") ?? "";
  const rel = req.nextUrl.searchParams.get("path") ?? "";
  if (!/^V\d{2}$/.test(id) || !/^(docs|fix)\/[a-z0-9_]+\.(pdf|jpg)$/.test(rel)) return new Response("Not found", { status: 404 });
  try {
    const bytes = fs.readFileSync(scenarioFile(id, rel));
    return new Response(bytes, {
      headers: { "content-type": rel.endsWith(".pdf") ? "application/pdf" : "image/jpeg", "cache-control": "public, max-age=3600" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
