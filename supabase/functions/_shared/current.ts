// What a model remembers about AI products stops at its training date. Asked
// for a working title on a Claude channel in November 2026, it wrote "Claude
// 3.7 Sonnet" into dozens of ideas (Ivan, 2026-11-09). So: today's date, no
// versions from memory, and a check on the output for the bulk call.
export function currentRule(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `\n\nToday is ${today}. What you remember about AI models and software is out of date. Never write a version number, price or release of any product unless it appears in the material above. Use the bare name instead: "Claude", not a numbered Claude.`;
}

const VERSIONED = /\b(?:claude|sonnet|opus|haiku|fable|chatgpt|gpt|gemini|llama|grok|deepseek|qwen)[\s-]*(?:o?\d[\d.]*)/gi;

// True when `text` names a product version that `source` does not.
export function inventsVersion(text: string, source: string): boolean {
  const known = source.toLowerCase();
  return (text.match(VERSIONED) ?? []).some(v => !known.includes(v.toLowerCase()));
}
