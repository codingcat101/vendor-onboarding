// Pure helper, safe to import in the browser.
import type { DocSlot, ExtractedDoc, Submission } from "./types";

/** Which inputs differ between two submissions (+ their document readings). Used for incremental re-checks. */
export function diffInputs(
  a: { sub: Submission; docs: Partial<Record<DocSlot, ExtractedDoc>> },
  b: { sub: Submission; docs: Partial<Record<DocSlot, ExtractedDoc>> },
): string[] {
  const changed: string[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (typeof x === "object" && x && typeof y === "object" && y) {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of keys) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${path}.${k}`);
    } else if (JSON.stringify(x) !== JSON.stringify(y)) changed.push(path);
  };
  walk(a.sub, b.sub, "form");
  const slots = new Set([...Object.keys(a.docs), ...Object.keys(b.docs)]) as Set<DocSlot>;
  for (const s of slots) if (JSON.stringify(a.docs[s]) !== JSON.stringify(b.docs[s])) changed.push(`doc.${s}`);
  return changed;
}
