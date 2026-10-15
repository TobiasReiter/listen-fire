import { jsonrepair } from 'jsonrepair';

import { logger } from '../../services/logger';

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

/**
 * `parseJson` for LLM replies — degrades instead of throwing, because a
 * model reply is never trustworthy enough to crash on:
 * - an empty reply (a completion with no text blocks) → `null`;
 * - a reply no repair pass can parse → the raw text, verbatim.
 *
 * Consumers already handle both shapes: AI()'s envelope projection
 * treats null as "no value" and a bare string as the answer itself;
 * extraction's zod validation rejects either and retries with the
 * validation issues. Crashing here turned an empty reply into
 * `jsonrepair`'s "Unexpected end of json string at position 0" — a
 * run-killing error with no hint of its cause.
 */
function parseJsonReply(
  text: string,
  options?: { label?: string; prompt?: string },
): unknown {
  const promptSnippet = options?.prompt?.slice(0, 300);
  if (text.trim() === '') {
    logger.warn('[llm] empty reply — resolving to null', {
      label: options?.label,
      prompt: promptSnippet,
    });
    return null;
  }
  try {
    return parseJson(text);
  } catch {
    logger.warn('[llm] unparsable reply — passing raw text through', {
      label: options?.label,
      prompt: promptSnippet,
      length: text.length,
      snippet: text.slice(0, 200),
    });
    return text;
  }
}

export { parseJson, parseJsonReply };
