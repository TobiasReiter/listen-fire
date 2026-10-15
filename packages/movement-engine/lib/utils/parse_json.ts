import { jsonrepair } from 'jsonrepair';

/**
 * Walk the JSON string and escape double-quotes that appear inside string
 * values but aren't properly escaped. The heuristic: a `"` inside a string
 * is a real close-quote only if the next non-whitespace character is one of
 * `:`, `,`, `}`, `]` (i.e. valid JSON structure after a string).  Otherwise
 * we treat it as an unescaped interior quote and prepend a backslash.
 */
function escapeInteriorQuotes(json: string): string {
  let result = '';
  let inString = false;
  let i = 0;

  while (i < json.length) {
    const ch = json[i];

    if (!inString) {
      result += ch;
      if (ch === '"') inString = true;
      i++;
    } else if (ch === '\\') {
      // Escape sequence — copy both chars verbatim
      result += ch + (json[i + 1] ?? '');
      i += 2;
    } else if (ch === '"') {
      // Is this the real end of the string or an unescaped interior quote?
      const rest = json.slice(i + 1);
      if (/^\s*[,:}\]]/.test(rest) || /^\s*$/.test(rest)) {
        result += '"';
        inString = false;
      } else {
        result += '\\"';
      }
      i++;
    } else {
      result += ch;
      i++;
    }
  }

  return result;
}

function parseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  // Strip markdown code blocks (extract content between fences)
  let json = text;
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    json = codeBlockMatch[1];
  }
  const beforeTrim = json;

  // Trim prose before the first { or [ and after the last } or ]
  json = json.replace(/^[^[{]*/, '');
  const lastBracket = Math.max(json.lastIndexOf('}'), json.lastIndexOf(']'));
  if (lastBracket !== -1) json = json.slice(0, lastBracket + 1);

  try {
    return JSON.parse(json);
  } catch { /* continue */ }

  // Fix unescaped quotes inside string values (e.g. PFAS ("forever chemicals"))
  const escaped = escapeInteriorQuotes(json);
  try {
    return JSON.parse(escaped);
  } catch { /* continue */ }

  // Truncated replies (max_tokens): the prose-trim above cuts at the LAST
  // closing bracket, dropping every entry after it — jsonrepair can close
  // the unbalanced ORIGINAL instead and keep them. Gated to replies that
  // are bare JSON from the first character: on prose, jsonrepair "repairs"
  // the words themselves into junk values instead of throwing.
  if (/^\s*[[{]/.test(beforeTrim)) {
    try {
      return JSON.parse(jsonrepair(beforeTrim));
    } catch { /* continue */ }
  }

  const repaired = jsonrepair(escaped);
  return JSON.parse(repaired);
}

export { parseJson };
