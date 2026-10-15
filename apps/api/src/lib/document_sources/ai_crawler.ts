import { createHash } from "node:crypto";

import { Page } from 'playwright';
import { z } from 'zod';

import type Anthropic from '@anthropic-ai/sdk';

import { chatCallFor } from '../models/chat';
import { logger } from 'movement-engine/services/logger';
import { recordLlmUsage } from '../llm_usage';
import { Screenshot } from '../../services/crawler';
import { sendSlackNotification } from '../slack';
import { handleError } from '../errors';
import { Prompt } from '../prompts';

// ── Types ──────────────────────────────────────────────────────────────────

const authGateSchema = z.object({
  pageType: z.literal('auth_gate'),
  confidence: z.number(),
  reasoning: z.string(),
  emailField: z.string().optional(),
  passwordField: z.string().optional(),
  submitButton: z.string().optional(),
  requiresOAuth: z.boolean(),
  requiresVerification: z.boolean(),
});

const dataRoomSchema = z.object({
  pageType: z.literal('data_room'),
  confidence: z.number(),
  reasoning: z.string(),
  documents: z.array(
    z.object({
      name: z.string(),
      selector: z.string(),
      likelyDeck: z.boolean(),
    }),
  ),
});

const deckViewerSchema = z.object({
  pageType: z.literal('deck_viewer'),
  confidence: z.number(),
  reasoning: z.string(),
  contentSelector: z.string(),
  navigation: z.discriminatedUnion('method', [
    z.object({ method: z.literal('next_button'), selector: z.string() }),
    z.object({ method: z.literal('scroll'), direction: z.enum(['vertical', 'horizontal']) }),
    z.object({ method: z.literal('keyboard'), key: z.string() }),
  ]),
  currentPage: z.number().optional(),
  totalPages: z.number().optional(),
  uiElementsToHide: z.array(z.string()).optional(),
});

const apiRedirectSchema = z.object({
  pageType: z.literal('api_accessible'),
  confidence: z.number(),
  reasoning: z.string(),
  platform: z.enum(['notion', 'google_drive', 'google_slides', 'google_sheets']),
  resourceId: z.string(),
});

const errorSchema = z.object({
  pageType: z.literal('error_page'),
  confidence: z.number(),
  reasoning: z.string(),
  errorType: z.enum(['not_found', 'access_denied', 'expired', 'other']),
});

const unknownSchema = z.object({
  pageType: z.literal('unknown'),
  confidence: z.number(),
  reasoning: z.string(),
  suggestedAction: z.string().optional(),
});

const pageAssessmentSchema = z.discriminatedUnion('pageType', [
  authGateSchema,
  dataRoomSchema,
  deckViewerSchema,
  apiRedirectSchema,
  errorSchema,
  unknownSchema,
]);

type PageAssessment = z.infer<typeof pageAssessmentSchema>;
type DeckViewerAssessment = z.infer<typeof deckViewerSchema>;
type AuthGateAssessment = z.infer<typeof authGateSchema>;

const confirmationSchema = z.object({
  isCorrect: z.boolean(),
  reasoning: z.string(),
});

type StepLog = {
  step: number;
  screenshot: Buffer;
  assessment: PageAssessment;
  actionTaken: string;
};

type AICrawlResult =
  | { type: 'screenshots'; data: Screenshot[] }
  | { type: 'api_redirect'; platform: string; resourceId: string }
  | { type: 'needs_verification'; steps: StepLog[] }
  | { type: 'failed'; reason: string; steps: StepLog[] };

// ── Anthropic client ───────────────────────────────────────────────────────

// The crawler asks Claude what kind of page it has landed on, wherever the
// model map sends that name. The factory reads its credentials at first USE,
// not at module load, so merely importing this file cannot stop the process
// booting.

const VISION_MODEL = 'claude-sonnet-5';

async function visionCall(opts: {
  system: string;
  screenshot: Buffer;
  text: string;
  label: string;
}): Promise<string> {
  const startMs = Date.now();
  const { client, wireModel, resolved } = chatCallFor(VISION_MODEL);
  const response = await client.messages.create({
    model: wireModel,
    max_tokens: 4096,
    system: opts.system,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: opts.screenshot.toString('base64'),
            },
          },
          { type: 'text', text: opts.text },
        ],
      },
    ],
  });
  const durationMs = Date.now() - startMs;

  recordLlmUsage({
    resolved,
    callType: 'chat',
    label: opts.label,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    durationMs,
  }).catch(() => {});

  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function parseJsonFromLLM(text: string): unknown {
  // Strip markdown code blocks
  let json = text;
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    json = codeBlockMatch[1];
  }
  // Trim prose before first { or [
  json = json.replace(/^[^[{]*/, '');
  return JSON.parse(json);
}

// ── Interactive element extraction ─────────────────────────────────────────

interface InteractiveElementMap {
  buttons: { text: string; selector: string }[];
  links: { text: string; href: string; selector: string }[];
  inputs: { label: string; type: string; name: string; selector: string }[];
}

async function getInteractiveElements(page: Page): Promise<InteractiveElementMap> {
  return page.evaluate(() => {
    function isVisible(el: Element): boolean {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
        return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function getUniqueSelector(el: Element): string {
      if (el.getAttribute('data-testid')) {
        return `[data-testid="${el.getAttribute('data-testid')}"]`;
      }
      if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
        return `#${CSS.escape(el.id)}`;
      }
      if (el.getAttribute('name')) {
        const sel = `${el.tagName.toLowerCase()}[name="${el.getAttribute('name')}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
      if (el.getAttribute('aria-label')) {
        const sel = `${el.tagName.toLowerCase()}[aria-label="${el.getAttribute('aria-label')}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
      // Fallback: build a path with nth-of-type
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur !== document.body) {
        const tag = cur.tagName.toLowerCase();
        const par: Element | null = cur.parentElement;
        if (par) {
          const siblings = Array.from(par.children).filter(
            (c) => c.tagName === cur!.tagName,
          );
          if (siblings.length > 1) {
            const idx = siblings.indexOf(cur) + 1;
            parts.unshift(`${tag}:nth-of-type(${idx})`);
          } else {
            parts.unshift(tag);
          }
        } else {
          parts.unshift(tag);
        }
        cur = par;
      }
      return parts.join(' > ');
    }

    function truncate(text: string, max: number): string {
      return text.length > max ? text.slice(0, max) + '…' : text;
    }

    const buttons: { text: string; selector: string }[] = [];
    for (const el of Array.from(document.querySelectorAll(
      'button, [role="button"], input[type="submit"]',
    ))) {
      if (!isVisible(el)) continue;
      const text =
        el.getAttribute('aria-label') ||
        (el as HTMLElement).innerText?.trim() ||
        el.getAttribute('title') ||
        '';
      buttons.push({ text: truncate(text, 50), selector: getUniqueSelector(el) });
    }

    const links: { text: string; href: string; selector: string }[] = [];
    for (const el of Array.from(document.querySelectorAll('a[href]'))) {
      if (!isVisible(el)) continue;
      const text = (el as HTMLElement).innerText?.trim() || el.getAttribute('title') || '';
      links.push({
        text: truncate(text, 50),
        href: (el as HTMLAnchorElement).href,
        selector: getUniqueSelector(el),
      });
    }

    const inputs: { label: string; type: string; name: string; selector: string }[] = [];
    for (const el of Array.from(document.querySelectorAll('input, textarea, select'))) {
      if (!isVisible(el)) continue;
      const inputEl = el as HTMLInputElement;
      const label =
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() ||
        '';
      inputs.push({
        label: truncate(label, 50),
        type: inputEl.type || 'text',
        name: inputEl.name || '',
        selector: getUniqueSelector(el),
      });
    }

    return { buttons, links, inputs };
  });
}

function serializeElementMap(elements: InteractiveElementMap): string {
  const lines: string[] = [];

  if (elements.buttons.length > 0) {
    lines.push('BUTTONS:');
    elements.buttons.forEach((b, i) => {
      lines.push(`  [${i}] "${b.text}" → ${b.selector}`);
    });
  }

  if (elements.inputs.length > 0) {
    lines.push('INPUTS:');
    elements.inputs.forEach((inp, i) => {
      lines.push(`  [${i}] "${inp.label}" (type=${inp.type}) → ${inp.selector}`);
    });
  }

  if (elements.links.length > 0) {
    lines.push('LINKS:');
    elements.links.forEach((l, i) => {
      lines.push(`  [${i}] "${l.text}" → ${l.selector}`);
    });
  }

  return lines.length > 0 ? lines.join('\n') : '(no interactive elements found)';
}

// ── Highlight / confirm ────────────────────────────────────────────────────

async function highlightElement(page: Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate((el) => {
    (el as HTMLElement).style.outline = '4px solid #ff00ff';
    (el as HTMLElement).style.outlineOffset = '2px';
  });
}

async function removeHighlight(page: Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate((el) => {
    (el as HTMLElement).style.outline = '';
    (el as HTMLElement).style.outlineOffset = '';
  });
}

async function confirmElement(page: Page, selector: string): Promise<boolean> {
  const el = page.locator(selector);
  try {
    if (!(await el.isVisible())) return false;
  } catch {
    return false;
  }

  await highlightElement(page, selector);
  const screenshot = await page.screenshot();
  await removeHighlight(page, selector);

  const raw = await visionCall({
    system: `You are verifying an element selection on a web page.

The element with the magenta border/outline is supposed to be the main content area of a pitch deck viewer — i.e., the slide or document page itself.

Is this the correct element? Consider:
- It should contain the actual slide/document content, not a toolbar, sidebar, or navigation panel
- It should be the largest content-bearing element, not a thumbnail or preview
- If the border is around the whole page or a very small element, it's probably wrong

Respond with ONLY a JSON object: { "isCorrect": boolean, "reasoning": "one sentence" }`,
    screenshot,
    text: `Selected element: ${selector}`,
    label: 'CONFIRM_CONTENT_ELEMENT',
  });

  try {
    const parsed = confirmationSchema.parse(parseJsonFromLLM(raw));
    return parsed.isCorrect;
  } catch {
    logger.info('Failed to parse confirmation response, assuming incorrect', { raw });
    return false;
  }
}

// ── Page assessment ────────────────────────────────────────────────────────

const ASSESS_SYSTEM_PROMPT = `You are analyzing a web page screenshot to help scrape a pitch deck PDF.

Your job is to classify the page and identify actionable elements. The page is one of:

**auth_gate** — The page is asking for credentials before showing content.
- Look for: email/password input fields, "Enter your email to continue", login forms
- Note whether it requires OAuth ("Sign in with Google/Microsoft") — we can't handle that
- Note whether it requires email verification (a code sent to your inbox) — we handle that separately

**data_room** — The page shows a list of documents, folders, or files we need to navigate through to find content.
- Look for: file listings, folder trees, document indexes, or any page showing clickable items that lead to documents
- This includes: flat file lists, hierarchical folder browsers (e.g. DocSend Spaces, data rooms with sidebar navigation), file directories with icons/sizes/dates
- Folders count as documents too — clicking a folder navigates deeper into the file structure
- For each clickable document or folder visible, note its name and whether it looks like it leads to a pitch deck (or a folder likely containing one, e.g. "Fundraising", "Pitch", "Investor Materials")

**deck_viewer** — The page is displaying pitch deck content (slides or a document).
- Identify the main content element (the slide/page area, NOT the toolbar or sidebar)
- Identify how to navigate: a "next" button, scrolling, or keyboard arrows
- Identify UI elements that should be hidden before screenshotting (toolbars, floating buttons, watermarks, share overlays)

**api_accessible** — The content is on a platform we have API access to (Notion, Google Drive, Google Slides).
- Look for: notion.so, notion.site or app.notion.com in the URL, docs.google.com, drive.google.com
- Extract the resource ID from the URL

**error_page** — Something went wrong (404, access denied, expired link, CAPTCHA).

**unknown** — Can't determine the page type. This might mean the page is still loading.

IMPORTANT: When referencing elements, use the selectors from the ELEMENTS list provided — do NOT invent selectors.

Respond with ONLY a JSON object. Always include "pageType", "confidence" (0-1), and "reasoning" (one sentence).`;

async function assessPage(page: Page): Promise<PageAssessment> {
  const screenshot = await page.screenshot();
  const elements = await getInteractiveElements(page);
  const serialized = serializeElementMap(elements);
  const url = page.url();

  const raw = await visionCall({
    system: ASSESS_SYSTEM_PROMPT,
    screenshot,
    text: `URL: ${url}\n\nELEMENTS:\n${serialized}`,
    label: 'ASSESS_DECK_PAGE',
  });

  try {
    return pageAssessmentSchema.parse(parseJsonFromLLM(raw));
  } catch (err) {
    logger.info('Failed to parse page assessment, returning unknown', { raw, err });
    return { pageType: 'unknown', confidence: 0, reasoning: 'Failed to parse assessment' };
  }
}

// ── Auth filling ───────────────────────────────────────────────────────────

async function fillAuth(
  page: Page,
  assessment: AuthGateAssessment,
  opts: { email?: string; passcode?: string },
): Promise<void> {
  if (assessment.emailField && opts.email) {
    await page.locator(assessment.emailField).fill(opts.email);
  }
  if (assessment.passwordField && opts.passcode) {
    await page.locator(assessment.passwordField).fill(opts.passcode);
  }
  if (assessment.submitButton) {
    await page.waitForTimeout(500);
    await page.locator(assessment.submitButton).click();
  }
}

// ── Slide capture ──────────────────────────────────────────────────────────

function simpleImageHash(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex');
}

/**
 * Capture all slides from a deck viewer. Uses two strategies:
 *
 * - **Discrete navigation** (next_button, keyboard): The content element redraws
 *   with each advance. Screenshot the element, advance, check for duplicates.
 *
 * - **Scroll**: The content element is a scroll container with content taller
 *   than its visible area. We use precise scrollTo positioning to capture
 *   viewport-height tiles without overlap or gaps.
 */
async function captureAllSlides(
  page: Page,
  assessment: DeckViewerAssessment,
): Promise<Screenshot[]> {
  // Hide distracting UI elements
  for (const selector of assessment.uiElementsToHide ?? []) {
    await page
      .locator(selector)
      .evaluate((el) => {
        (el as HTMLElement).style.setProperty('opacity', '0', 'important');
        (el as HTMLElement).style.setProperty('pointer-events', 'none', 'important');
      })
      .catch(() => {});
  }

  const contentEl = page.locator(assessment.contentSelector);
  const nav = assessment.navigation;

  if (nav.method === 'scroll') {
    return captureScrollContent(page, contentEl, assessment.contentSelector);
  }

  return captureDiscreteSlides(page, contentEl, nav);
}

/**
 * For scroll containers: scroll through the content taking viewport-height
 * screenshots, returned as tiles. The caller (buildPdfFromScreenshots or
 * buildPdf) places each tile on a separate PDF page.
 *
 * However, for continuous content this produces page breaks that bisect text.
 * To handle this, we return the tiles with a `scrollTiles` flag so the PDF
 * builder can compose them onto a single tall page instead of separate pages.
 *
 * We scroll via precise scrollTo (not mouse.wheel) so each tile is positioned
 * exactly. Content that lazy-loads on scroll will render as we reach it.
 */
async function captureScrollContent(
  page: Page,
  contentEl: ReturnType<Page['locator']>,
  contentSelector: string,
): Promise<Screenshot[]> {
  const dims = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      clientWidth: el.clientWidth,
    };
  }, contentSelector);

  if (!dims || dims.scrollHeight <= 0 || dims.clientHeight <= 0) {
    return [];
  }

  const { scrollHeight, clientHeight, clientWidth } = dims;
  const tiles: Screenshot[] = [];
  const MAX_TILES = 200;

  for (let offset = 0, i = 0; offset < scrollHeight && i < MAX_TILES; offset += clientHeight, i++) {
    await page.evaluate(
      ({ sel, top }) => {
        document.querySelector(sel)?.scrollTo({ top, behavior: 'instant' });
      },
      { sel: contentSelector, top: offset },
    );
    await page.waitForTimeout(300);

    const data = await contentEl.screenshot();
    const tileHeight = Math.min(clientHeight, scrollHeight - offset);
    tiles.push({ width: clientWidth, height: tileHeight, data });
  }

  if (tiles.length === 0) return [];

  // Mark these as scroll tiles so the PDF builder can stitch them into
  // one tall page. We do this by returning a single Screenshot with the
  // combined height and a `tiles` property containing the individual images.
  // Since Screenshot is { width, height, data }, we synthesize a placeholder
  // that buildScrollPdf will handle specially.
  return scrollTilesToSinglePage(tiles, clientWidth);
}

/**
 * Combine viewport-height scroll tiles into a single "page" worth of
 * screenshot data. We don't actually stitch pixels — instead we return
 * the tiles as-is but with metadata that buildPdf/buildPdfFromScreenshots
 * can use to place them at sequential y-offsets on one tall PDF page.
 *
 * Since the Screenshot type doesn't carry tile info, we store the tiles
 * in a module-level map keyed by a sentinel buffer, and the PDF builder
 * retrieves them. This avoids changing the Screenshot type which is used
 * across all crawlers.
 */
const scrollTileMap = new Map<string, { tiles: Screenshot[]; totalWidth: number }>();

function scrollTilesToSinglePage(tiles: Screenshot[], width: number): Screenshot[] {
  const totalHeight = tiles.reduce((sum, t) => sum + t.height, 0);
  // Create a unique key for this set of tiles
  const key = `scroll_${Date.now()}_${Math.random()}`;
  scrollTileMap.set(key, { tiles, totalWidth: width });

  // Return a single Screenshot whose data is a sentinel containing the key.
  // buildScrollPage will detect this and compose the tiles.
  const sentinel = Buffer.from(`__SCROLL_TILES__:${key}`);
  return [{ width, height: totalHeight, data: sentinel }];
}

/**
 * Check if a Screenshot is a scroll-tile sentinel and retrieve the tiles.
 */
function getScrollTiles(screenshot: Screenshot): Screenshot[] | null {
  const str = screenshot.data.toString('utf8');
  if (!str.startsWith('__SCROLL_TILES__:')) return null;
  const key = str.slice('__SCROLL_TILES__:'.length);
  const entry = scrollTileMap.get(key);
  if (!entry) return null;
  scrollTileMap.delete(key);
  return entry.tiles;
}

/**
 * For discrete slide navigation (next button, keyboard arrows): screenshot
 * the content element, advance, and use hash-based duplicate detection to
 * know when we've reached the last slide.
 */
async function captureDiscreteSlides(
  page: Page,
  contentEl: ReturnType<Page['locator']>,
  nav: DeckViewerAssessment['navigation'],
): Promise<Screenshot[]> {
  const screenshots: Screenshot[] = [];
  const MAX_SLIDES = 200;
  let lastHash: string | null = null;

  for (let i = 0; i < MAX_SLIDES; i++) {
    await page.waitForTimeout(500);
    const box = await contentEl.boundingBox();
    if (!box) break;

    const data = await contentEl.screenshot();
    const hash = simpleImageHash(data);

    if (hash === lastHash) break;
    lastHash = hash;

    screenshots.push({ width: box.width, height: box.height, data });

    // Advance to next slide
    try {
      if (nav.method === 'next_button') {
        const nextBtn = page.locator(nav.selector);
        const visible = await nextBtn.isVisible();
        const enabled = visible && (await nextBtn.isEnabled());
        if (!visible || !enabled) break;
        await nextBtn.click();
      } else if (nav.method === 'keyboard') {
        await page.keyboard.press(nav.key);
      }
    } catch {
      break;
    }
  }

  return screenshots;
}

// ── Main loop ──────────────────────────────────────────────────────────────

const MAX_STEPS = 15;

async function aiCaptureContent(
  page: Page,
  opts: { email?: string; passcode?: string },
): Promise<AICrawlResult> {
  const steps: StepLog[] = [];

  logger.info('AI crawler: starting content capture', { url: page.url() });

  for (let step = 0; step < MAX_STEPS; step++) {
    const assessment = await assessPage(page);
    const screenshot = await page.screenshot();
    steps.push({ step, screenshot, assessment, actionTaken: '' });

    logger.info('AI crawler: step', {
      step,
      pageType: assessment.pageType,
      confidence: assessment.confidence,
      reasoning: assessment.reasoning,
    });

    switch (assessment.pageType) {
      case 'deck_viewer': {
        const confirmed = await confirmElement(page, assessment.contentSelector);
        if (!confirmed) {
          steps[steps.length - 1].actionTaken = 'content selector rejected, re-assessing';
          continue;
        }

        const screenshots = await captureAllSlides(page, assessment);
        if (screenshots.length > 0) {
          logger.info('AI crawler: captured slides', { count: screenshots.length });
          return { type: 'screenshots', data: screenshots };
        }
        steps[steps.length - 1].actionTaken = 'capture returned empty, re-assessing';
        continue;
      }

      case 'auth_gate': {
        if (assessment.requiresOAuth) {
          return { type: 'failed', reason: 'requires OAuth', steps };
        }
        if (assessment.requiresVerification) {
          return { type: 'needs_verification', steps };
        }

        await fillAuth(page, assessment, opts);
        steps[steps.length - 1].actionTaken = 'filled auth and submitted';
        await page.waitForTimeout(3000);
        continue;
      }

      case 'data_room': {
        const deck =
          assessment.documents.find((d) => d.likelyDeck) ?? assessment.documents[0];

        if (!deck) {
          // If the AI didn't identify documents, try the existing text-based picker
          return { type: 'failed', reason: 'data room with no documents identified', steps };
        }

        try {
          await page.locator(deck.selector).click();
          steps[steps.length - 1].actionTaken = `clicked "${deck.name}"`;
        } catch {
          steps[steps.length - 1].actionTaken = `failed to click "${deck.name}"`;
        }
        await page.waitForTimeout(2000);
        continue;
      }

      case 'api_accessible': {
        return {
          type: 'api_redirect',
          platform: assessment.platform,
          resourceId: assessment.resourceId,
        };
      }

      case 'error_page': {
        return { type: 'failed', reason: `error page: ${assessment.errorType}`, steps };
      }

      case 'unknown': {
        // Bail out early if we've seen too many consecutive unknowns (parse failures or genuinely unrecognised pages)
        const recentUnknowns = steps.filter((s) => s.assessment.pageType === 'unknown').length;
        if (recentUnknowns >= 3) {
          return { type: 'failed', reason: 'repeated unknown assessments — page is not a supported document type', steps };
        }
        // If the LLM is confident this isn't a deck/data-room/auth-gate, stop immediately
        if (assessment.confidence >= 0.8 && !assessment.reasoning.includes('Failed to parse')) {
          return { type: 'failed', reason: `page classified as unknown with high confidence: ${assessment.reasoning}`, steps };
        }
        steps[steps.length - 1].actionTaken = 'unknown page, waiting and retrying';
        await page.waitForTimeout(3000);
        continue;
      }
    }
  }

  return { type: 'failed', reason: 'max steps exceeded', steps };
}

// ── Observability ──────────────────────────────────────────────────────────

async function reportAIResult(url: string, result: AICrawlResult, context: string): Promise<void> {
  try {
    if (result.type === 'screenshots') {
      await sendSlackNotification({
        type: 'DEALFLOW',
        text: `:robot_face: AI crawler succeeded for ${context}\nURL: ${url}\nSlides captured: ${result.data.length}`,
        opsTitle: `AI crawler captured ${result.data.length} slides for ${context}`,
      });
    } else if (result.type === 'failed') {
      await sendSlackNotification({
        type: 'DEALFLOW',
        text: `:warning: AI crawler failed for ${context}\nURL: ${url}\nReason: ${result.reason}\nSteps taken: ${result.steps.length}`,
        opsTitle: `AI crawler failed for ${context} (${url}) — ${result.reason}`,
      });
    }
  } catch (err) {
    handleError(err);
  }
}

export {
  aiCaptureContent,
  assessPage,
  confirmElement,
  getInteractiveElements,
  getScrollTiles,
  serializeElementMap,
  highlightElement,
  removeHighlight,
  reportAIResult,
};
export type { AICrawlResult, PageAssessment, StepLog, InteractiveElementMap };
