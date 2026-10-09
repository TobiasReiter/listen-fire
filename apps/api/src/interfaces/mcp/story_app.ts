// The automation's story, drawn INSIDE the conversation.
//
// MCP Apps (SEP-1865) let a tool nominate an HTML view the client renders in
// the chat and hands the tool's result to. `getAutomation` nominates this one:
// the same board the workbench draws and the same board a story link opens,
// so a person asking their agent "what does this actually do?" sees the
// picture without leaving the thread.
//
// TWO PIECES, and both are inert on their own:
//
//   the view — `apps/api/public/story/app.html`, one self-contained file. An
//   app is sandboxed with `default-src 'none'`, so a page that fetches its own
//   script renders nothing at all. Built by `pnpm --filter story-view bundle`
//   (the API's build runs it); absent, `resources/read` fails and the client
//   falls back to the tool's text, which is exactly what it did before.
//
//   the story — projected here and attached to the result's `_meta`, where it
//   reaches the view and no model. Projection is the story link's own path
//   (`servedStoryView`, memoised on the source), so the picture in the chat
//   and the picture behind the link are the same picture.
//
// NOTHING HERE MAY FAIL A TOOL CALL. Every failure returns the result
// untouched: a client that never heard of Apps must see `getAutomation`
// behave exactly as it always has, and a client that has must degrade to the
// link rather than to a blank panel.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { McpToolResult, ToolApp } from './server';

import { lookupStoryToken } from '../../services/translation_graph/movement/story_token';
import { servedStoryView } from '../../services/translation_graph/movement/story_view';

import { STORY_APP_RESOURCE_URI, STORY_RESULT_META_KEY } from '#shared/constants/story_app';



/** Where the bundler leaves the single-file view — beside the link page's
 *  bundle, and deployed with it, so the two can never be different releases. */
const APP_HTML = path.resolve(process.cwd(), 'public/story/app.html');

let cachedHtml: Promise<string> | null = null;

/** The view. Read once per process: it changes only when the API is replaced. */
async function storyAppHtml(): Promise<string> {
  cachedHtml ??= readFile(APP_HTML, 'utf8');
  try {
    return await cachedHtml;
  } catch (err) {
    cachedHtml = null;
    throw err;
  }
}

/**
 * The story for a `getAutomation` result, keyed where the view looks for it.
 *
 * The result already carries the automation's story link, and that link's
 * token names the movement — so the view's data is derived from what the tool
 * returned rather than from a second lookup that could disagree with it.
 */
async function storyAppData(result: McpToolResult): Promise<Record<string, unknown> | undefined> {
  const text = result.content.find((part) => part.type === 'text')?.text;
  if (!text) return undefined;

  let body: { storyUrl?: unknown };
  try {
    body = JSON.parse(text) as { storyUrl?: unknown };
  } catch {
    return undefined;
  }
  if (typeof body.storyUrl !== 'string') return undefined;

  const token = body.storyUrl.split('/').pop() ?? '';
  const target = await lookupStoryToken(token);
  if (!target) return undefined;

  const projected = await servedStoryView({ teamId: target.teamId, id: target.movementId });
  // An unreadable program has no picture to draw. The view says so with the
  // link, which is what the agent would have offered anyway.
  if (!projected?.ok) return undefined;

  return { [STORY_RESULT_META_KEY]: projected.view };
}

/** The declaration `getAutomation` carries. */
const storyApp: ToolApp = {
  resourceUri: STORY_APP_RESOURCE_URI,
  title: 'What an automation does',
  description: 'The picture of an automation: its triggers, steps, and the records it touches.',
  html: storyAppHtml,
  data: storyAppData,
};

export { storyApp, storyAppData, storyAppHtml, APP_HTML };
