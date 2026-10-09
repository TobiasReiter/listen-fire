// Public capability-link route — `GET /api/story/:token`.
//
// A movement's story as a page anyone holding the link can open: no login, no
// app shell, no session. The token IS the authorisation, so this mounts BEFORE
// the auth middleware (the asks route's idiom, and for the same reason — the
// link may be all a recipient ever has).
//
// GET-ONLY, and there is nothing here a GET could change: no form, no POST
// sibling, no side effect. Prefetch-safe by construction, which matters when
// the link travels through clients that unfurl what they are shown.
//
// PROJECTED AT SERVE TIME. The page is not a snapshot taken when the link was
// minted — it loads the movement, checks it, and joins the display vocabulary
// on the way out. So the picture is always of the program that is saved right
// now, and the validity banner is always the truth about it. `servedStoryView`
// memoises on the source, so a hot link costs one row read.
//
// THE PAGE ITSELF is the story-view package's renderer, the same one the app's
// workbench panel mounts: this route serves an HTML shell with the projected
// view inlined as JSON, and the bundle hydrates it. Build the bundle with
//
//     pnpm --filter story-view bundle
//
// (the API's own build runs it, and the dev loop builds it at boot). Without
// it `/story/story.js` 404s and the page stays empty.

import { Router } from 'express';

import type { Request, Response } from 'express';
import type { StoryView } from '../../services/translation_graph/movement/story_view';

import { lookupStoryToken } from '../../services/translation_graph/movement/story_token';
import { servedStoryView } from '../../services/translation_graph/movement/story_view';

const storyRouter: ReturnType<typeof Router> = Router();

storyRouter.get('/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token ?? '');
  const target = await lookupStoryToken(token);
  // A token we never minted, one that was revoked, and one whose automation is
  // gone all say the same thing. Distinguishing them would answer a question
  // the holder of a bad link has no business asking.
  if (!target) return res.status(404).type('html').send(goneLinkPage());

  const result = await servedStoryView({ teamId: target.teamId, id: target.movementId });
  if (!result) return res.status(404).type('html').send(goneLinkPage());

  // A script we couldn't read produces no picture at all. On this surface that
  // matters more than in the app: the reader has no code view to switch to and
  // no way to tell a confident-looking diagram from a guess.
  if (!result.ok) {
    return res
      .status(200)
      .type('html')
      .send(
        notice(
          result.movement.name,
          'We can’t show this one right now',
          'There’s a problem in the automation itself, so there’s nothing safe to draw. Whoever set it up will see the details in Listen-Fire.',
        ),
      );
  }

  return res.status(200).type('html').send(storyPage(result.view));
});

/** The page: chrome-free shell + the view + the bundle that draws it. */
function storyPage(view: StoryView): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    // A capability link is not a public document. Nothing about it should be
    // discoverable to anyone who wasn't handed it.
    `<meta name="robots" content="noindex, nofollow">` +
    `<title>${escapeHtml(view.movement.name)} — Listen-Fire</title>` +
    `<link rel="icon" href="/favicon.svg">` +
    `<link rel="stylesheet" href="/story/story.css">` +
    `</head><body><div id="story-root"></div>` +
    // JSON in a script tag, not a JS literal: the only escape that can break
    // out of it is `</script`, and the replacement below closes exactly that.
    `<script type="application/json" id="story-view-data">${escapeJson(view)}</script>` +
    `<script src="/story/story.js" defer></script>` +
    `</body></html>`
  );
}

/** A plain page for a link that no longer stands for anything, and for a
 *  program we can't draw. Deliberately dependency-free — whatever went wrong,
 *  this must render. */
function notice(title: string, heading: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex, nofollow">` +
    `<title>${escapeHtml(title)}</title>` +
    `<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:28rem;margin:6rem auto;padding:0 1.5rem;color:#1a1a1a;line-height:1.55}` +
    `h1{font-size:1.15rem;margin:0 0 .5rem}p{color:#666;margin:0}` +
    `.brand{font-size:.7rem;letter-spacing:.16em;text-transform:uppercase;color:#8778F7;margin-bottom:1.5rem}</style>` +
    `</head><body><div class="brand">Listen-Fire</div>` +
    `<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(body)}</p></body></html>`
  );
}

function goneLinkPage(): string {
  return notice(
    'Link not found',
    'This link isn’t live',
    'It may have been turned off, or the automation it showed no longer exists. Ask whoever shared it for a new one.',
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export { storyRouter };
