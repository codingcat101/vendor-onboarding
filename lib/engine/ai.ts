// Small helper for short text tasks (drafting a message, reading a reviewer's note).
// Fast model first, short timeout; callers always have a non-AI fallback.
const TEXT_MODELS = (process.env.GEMINI_TEXT_MODELS || "gemini-3.1-flash-lite,gemini-3-flash-preview").split(",").map((m) => m.trim());

export async function askJson<T>(prompt: string, schema: object, timeoutMs = 7000, maxModels = TEXT_MODELS.length): Promise<{ data: T; model: string } | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  for (const model of TEXT_MODELS.slice(0, maxModels)) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: schema },
        }),
      });
      if (!res.ok) continue;
      const j = await res.json();
      return { data: JSON.parse(j.candidates[0].content.parts[0].text) as T, model };
    } catch {
      /* try next model */
    } finally {
      clearTimeout(t);
    }
  }
  return null;
}
