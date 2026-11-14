import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse an OpenAI content-part array: a text-only array becomes a plain string,
// otherwise the array is returned as-is. Cache-aware targets retain marked blocks.
// The rule mirrors formats/openai.js filterToOpenAIFormat: all-text and no
// surviving cache_control => join with "\n". The single-part case is the same
// rule with nothing to join, so it still returns parts[0].text unchanged.
// Text-only-in-multiple-blocks used to stay an array, which strict targets
// (ollama gpt-oss:*, /alpha/generate) rejected — they only take string content.
export function collapseTextParts(parts, opts = {}) {
  if (!Array.isArray(parts) || parts.length === 0) return parts;
  const allText = parts.every((p) => p && p.type === OPENAI_BLOCK.TEXT);
  const keepCache = !!opts.preserveCacheControl && parts.some((p) => p?.cache_control);
  if (!allText || keepCache) return parts;
  return parts.map((p) => p.text || "").join("\n");
}
