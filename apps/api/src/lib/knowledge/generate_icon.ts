import { Resvg } from '@resvg/resvg-js';

import type Anthropic from '@anthropic-ai/sdk';

import { chatCallFor } from '../models/chat';
import { logger } from '../../services/logger';

const MAX_REFINEMENTS = 3;

const ICON_MODEL = 'claude-opus-4-7';

const SYSTEM_PROMPT = `You are an expert icon designer creating minimal SVG icons for a sidebar navigation UI. These icons are displayed at 16x16 pixels — every design decision must serve legibility at that size.

Your process:
1. First, reason out loud about what makes this concept DISTINCT from related concepts. What's the one thing that separates it from similar ideas? Don't reach for the obvious "document with a checkmark" or "page with lines" — those are generic. Think about the ACTIVITY, the TOOL, the CONTEXT, or the OUTCOME that's unique to this concept. A shareholder resolution is about VOTING. An accounting note is about a LEDGER. Dig deeper.
2. Pick a concrete, recognizable visual metaphor based on that distinctive quality. Avoid generic document/page icons unless the concept is literally "document." Avoid anything offensive, suggestive, or confusing at small sizes. No human figures, faces, body parts, religious symbols, or culturally sensitive imagery.
3. Plan the geometry — what shapes, how they compose, where they sit in the 24x24 viewBox.
4. Then output the SVG.

Small-size design principles — these are critical:
- BOLD AND SIMPLE: Use 2-3 large, distinct shapes rather than many small details. Each shape should be clearly distinguishable at 16px.
- NO CRAMPING: Leave generous breathing room between elements. If two shapes are close together, they will merge into a blob at 16px. Minimum 2px gap between any two strokes/shapes in the 24-unit viewBox.
- FILL THE SPACE: The primary shape should be substantial — roughly 14-16 units across. Don't draw a tiny symbol floating in a big empty box.
- AVOID FINE DETAIL: No thin parallel lines, no intricate patterns, no small dots or notches. These disappear or become noise at small sizes. Prefer one clear shape over multiple fiddly ones.
- AVOID ENCLOSED SMALL FEATURES: Don't put small shapes inside larger shapes if the inner shape would be < 4 viewBox units. It will be illegible.

SVG rules — you MUST follow all of these:
- This is raw SVG/XML, NOT JSX — use kebab-case attributes: stroke-width, stroke-linecap, stroke-linejoin (NOT strokeWidth, strokeLinecap, etc.)
- viewBox must be exactly "0 0 24 24"
- Use stroke only — no fill on any shape (use fill="none" on the root <svg>)
- stroke="currentColor" on the root <svg> so the icon inherits text color
- stroke-width="1.5"
- stroke-linecap="round" and stroke-linejoin="round"
- No text elements, no gradients, no filters, no clip-paths, no masks
- No <defs>, <use>, <symbol>, or <g> elements — keep it flat
- Use only: <path>, <circle>, <rect>, <line>, <polyline>, <polygon>, <ellipse>
- Keep it simple — aim for 2-4 elements maximum
- Center the visual weight in the viewBox
- Leave ~2px padding from the edges (keep shapes within roughly 3-21 range)

Style reference: Lucide icons / Heroicons outline style. Clean, geometric, minimal.

Format your response as:
THINKING: [your reasoning about metaphor and geometry]
METAPHOR: [2-5 word label for the visual metaphor you chose, e.g. "ballot box", "open ledger", "magnifying glass"]
SVG:
<svg ...>...</svg>`;

const REFINE_SYSTEM_PROMPT = `You are an expert icon designer reviewing and improving your own work. These icons are displayed at 16x16 pixels. You will see:
1. The original concept
2. The current SVG markup
3. A rendered PNG of how it actually looks

Evaluate honestly — reason out loud about:
- Does it clearly depict a recognizable symbol at 16x16 pixels?
- Does it look clean and professional, like a Lucide/Heroicons icon?
- Are the proportions balanced? Is the visual weight centered?
- Could it be mistaken for something offensive, confusing, or nonsensical?
- Are paths/shapes well-formed, or are there rendering artifacts?
- SPACING: Are any strokes or shapes too close together? At 16px, strokes closer than ~2 viewBox units will merge into a blob. If elements are cramped, simplify or spread them out.
- PROPORTIONS: Does the primary shape fill the viewBox well (roughly 14-16 units across)? A tiny symbol in a big empty box looks wrong at small sizes.
- DETAIL: Are there any fine details (thin parallel lines, small dots, intricate patterns, tiny enclosed shapes) that will be illegible at 16px? Remove them.

If the icon is GOOD, respond with exactly: APPROVED

If it needs improvement, reason about what to fix, then output the improved SVG. When in doubt, simplify — fewer bold shapes always beats more detailed ones at this size.

SVG rules (same as before):
- viewBox "0 0 24 24", stroke only, fill="none", stroke="currentColor", stroke-width="1.5"
- stroke-linecap="round", stroke-linejoin="round"
- No text, gradients, filters, defs, use, symbol, g — flat shapes only
- 2-4 elements, centered, ~2px padding from edges

Format:
THINKING: [your critique and plan]
SVG:
<svg ...>...</svg>

Or just: APPROVED`;

/** Fix common LLM SVG mistakes: camelCase attributes, missing xmlns, etc. */
function sanitizeSvg(svg: string): string {
  const camelToKebab: Record<string, string> = {
    strokeWidth: 'stroke-width',
    strokeLinecap: 'stroke-linecap',
    strokeLinejoin: 'stroke-linejoin',
    strokeDasharray: 'stroke-dasharray',
    strokeDashoffset: 'stroke-dashoffset',
    strokeMiterlimit: 'stroke-miterlimit',
    strokeOpacity: 'stroke-opacity',
    fillOpacity: 'fill-opacity',
    fillRule: 'fill-rule',
    clipRule: 'clip-rule',
    clipPath: 'clip-path',
    viewBox: 'viewBox', // keep as-is — viewBox is correct in SVG
  };

  let result = svg;
  for (const [camel, kebab] of Object.entries(camelToKebab)) {
    if (camel === 'viewBox') continue;
    result = result.replaceAll(`${camel}=`, `${kebab}=`);
  }

  // Ensure xmlns is present on the root <svg>
  if (!result.includes('xmlns=')) {
    result = result.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
  }

  return result;
}

function svgToPng(svg: string): Buffer {
  const resvg = new Resvg(sanitizeSvg(svg), {
    fitTo: { mode: 'width', value: 256 },
    background: 'white',
  });
  const rendered = resvg.render();
  return Buffer.from(rendered.asPng());
}

/** Extract the last complete <svg>...</svg> block from text (the model's final answer). */
function extractSvg(text: string): string | null {
  // Match each individual <svg>...</svg> (non-greedy) and take the last one
  const matches = [...text.matchAll(/<svg[^>]*>[\s\S]*?<\/svg>/g)];
  if (!matches.length) return null;
  return sanitizeSvg(matches[matches.length - 1][0]);
}

/** Extract the METAPHOR: line from a response */
function extractMetaphor(text: string): string | null {
  const match = text.match(/METAPHOR:\s*(.+)/i);
  return match ? match[1].trim() : null;
}

export type ExistingIcon = { name: string; metaphor: string };

export async function generateIconSvg({ name, description, existingIcons }: {
  name: string;
  description?: string;
  existingIcons?: ExistingIcon[];
}): Promise<{ svg: string; metaphor: string }> {
  let conceptMessage = description
    ? `Create an icon for: "${name}" — ${description}`
    : `Create an icon for: "${name}"`;

  if (existingIcons?.length) {
    conceptMessage += `\n\nICONS ALREADY IN USE (you MUST pick a different visual metaphor from all of these):\n${existingIcons.map((i) => `- ${i.name}: ${i.metaphor}`).join('\n')}`;
  }

  // Step 1: Opus reasons about the metaphor and generates the initial SVG
  const { client, wireModel } = chatCallFor(ICON_MODEL);
  const initialResponse = await client.messages.create({
    model: wireModel,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: conceptMessage }],
  });

  const initialText = initialResponse.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const metaphor = extractMetaphor(initialText) ?? name;

  let svg = extractSvg(initialText);

  if (!svg) {
    logger.error('[generateIconSvg] No SVG found in initial response', { name });
    throw new Error('Failed to generate icon SVG');
  }

  // Step 2: iterative refinement — render to PNG, show it back, let Opus self-critique
  for (let i = 0; i < MAX_REFINEMENTS; i++) {
    let png: Buffer;
    try {
      png = svgToPng(svg);
    } catch (err) {
      logger.warn('[generateIconSvg] SVG render failed, skipping refinement', {
        name, iteration: i, error: err instanceof Error ? err.message : err,
      });
      break;
    }

    const refineResponse = await client.messages.create({
      model: wireModel,
      max_tokens: 2048,
      system: REFINE_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `Concept: "${name}"${description ? ` — ${description}` : ''}\n\nCurrent SVG:\n${svg}\n\nRendered result:` },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
        ],
      }],
    });

    const refineText = refineResponse.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    if (refineText.includes('APPROVED') && !extractSvg(refineText)) {
      logger.info('[generateIconSvg] Icon approved', { name, iterations: i + 1 });
      break;
    }

    const refined = extractSvg(refineText);
    if (!refined) {
      logger.info('[generateIconSvg] No SVG in refinement response, treating as approved', { name, iteration: i });
      break;
    }

    svg = refined;
  }

  return { svg, metaphor };
}
