// The callback HTTP door — `/api/cb/<id>` (callback-primitive layer 2).
//
// The id IS the authorization (like the ask link, like files, like webhook
// sync), so this mounts BEFORE auth. A BYO server calls the same POST with the
// same payload as any platform door; there is nothing platform-shaped here.
//
// GET NEVER FIRES. It renders a self-contained confirm page — the ask link
// page's idiom (one inline style block, no external assets, so it works from a
// link-only channel). Prefetch safety is the reason, and it is structural: the
// only resolving verb is POST.

import { Router, type Request, type Response } from 'express';

import type { CallbackParamSpec } from 'engine-contracts';

import { getCallback, type CallbackRecord } from '../../services/movement_engine/callback_store';
import { fireCallback, type CallbackFireOutcome } from '../../services/movement_engine/callback_fire';
import { logger } from 'movement-engine/services/logger';

export const callbacksRouter: ReturnType<typeof Router> = Router();

// GET — render only. A callback's `url` points here; a human follows it, reads
// what will happen, and POSTs.
callbacksRouter.get('/:id', async (req: Request, res: Response) => {
  const callback = await getCallback(req.params.id);
  if (callback === null) {
    res.status(404).type('html').send(messagePage('This link is not valid', 'Nothing here — the link may have been mistyped.'));
    return;
  }
  const terminal = terminalPage(callback);
  if (terminal) {
    res.status(terminal.status).type('html').send(terminal.html);
    return;
  }
  res.status(200).type('html').send(confirmPage(callback));
});

// POST — the only firing door. Values ride the JSON body, the urlencoded form,
// or the query string, mirroring the ask door's tolerance.
callbacksRouter.post('/:id', async (req: Request, res: Response) => {
  const wantsHtml = prefersHtml(req);
  let outcome: CallbackFireOutcome;
  try {
    outcome = await fireCallback({ id: req.params.id, values: readValues(req) });
  } catch (err) {
    // Express 4 does not catch a rejected handler: without this the caller
    // waits forever. The call may already be on the ledger; say so plainly.
    logger.error('[callbacks] firing failed', {
      id: req.params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    const message = 'Something went wrong recording that. Please try again in a moment.';
    if (wantsHtml) res.status(500).type('html').send(messagePage('Something went wrong', message));
    else res.status(500).json({ outcome: 'error', message });
    return;
  }
  const { status, message } = describeOutcome(outcome);
  if (wantsHtml) {
    res.status(status).type('html').send(
      outcome.kind === 'recorded'
        ? messagePage('Done', message)
        : messagePage(outcomeTitle(outcome), message),
    );
    return;
  }
  res.status(status).json({ outcome: outcome.kind, message });
});

/**
 * The supplied values: JSON body, urlencoded form, or query string — whichever
 * the caller had. Every key is passed through RAW; the router validates against
 * the stored signature and refuses loudly, so nothing here guesses.
 */
function readValues(req: Request): Record<string, unknown> {
  const body = req.body as Record<string, unknown> | undefined;
  const fromBody = body !== undefined && body !== null && typeof body === 'object' ? { ...body } : {};
  const fromQuery: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === 'string') fromQuery[key] = value;
  }
  return { ...fromQuery, ...fromBody };
}

/** A browser form post wants a page back; a platform door / BYO server wants
 *  JSON. Decided by what the caller ASKED for, never by what we'd rather send. */
function prefersHtml(req: Request): boolean {
  const accept = req.headers.accept ?? '';
  if (accept.includes('application/json')) return false;
  return accept.includes('text/html');
}

function outcomeTitle(outcome: CallbackFireOutcome): string {
  switch (outcome.kind) {
    case 'recorded':
      return 'Done';
    case 'not_found':
      return 'This link is not valid';
    case 'closed':
      return 'This action was closed';
    case 'expired':
      return 'This action has expired';
    case 'mismatch':
      return "That doesn't match what this action expects";
  }
}

function describeOutcome(outcome: CallbackFireOutcome): { status: number; message: string } {
  switch (outcome.kind) {
    case 'recorded':
      // Queued: recorded, and the workflow carries on as soon as it is free.
      return {
        status: outcome.queued ? 202 : 200,
        message: 'Thanks — that has been recorded and the workflow is carrying on.',
      };
    case 'not_found':
      return { status: 404, message: 'Nothing here — the link may have been mistyped.' };
    case 'closed':
      return {
        status: 410,
        message:
          'This is no longer open — it was already used, or the workflow it belonged to has finished. Nothing more is needed here.',
      };
    case 'expired':
      return { status: 410, message: 'This was only available for a limited time, and that window has passed.' };
    case 'mismatch':
      // LOUD, never a silent default: say exactly what was expected.
      return { status: 400, message: outcome.message };
  }
}

/** A revoked / already-fired / expired callback renders the closed page — the
 *  closed-request-wins idiom, on GET as well as POST. */
function terminalPage(callback: CallbackRecord): { status: number; html: string } | null {
  if (callback.status === 'fired') {
    return { status: 410, html: messagePage('This action was closed', 'This was already used. Nothing more is needed here.') };
  }
  if (callback.status === 'revoked') {
    return {
      status: 410,
      html: messagePage(
        'This action was closed',
        'The workflow this belonged to has finished, so there is nothing left to do here.',
      ),
    };
  }
  if (callback.expiresAt !== null && callback.expiresAt.getTime() <= Date.now()) {
    return {
      status: 410,
      html: messagePage('This action has expired', 'This was only available for a limited time, and that window has passed.'),
    };
  }
  return null;
}

// ── HTML (minimal, self-contained — no external assets) ───────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shell(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title>` +
    `<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem;color:#1a1a1a;line-height:1.5}` +
    `h1{font-size:1.25rem}button{font:inherit;padding:.6rem 1.1rem;border-radius:.5rem;border:1px solid #d0d0d0;background:#111;color:#fff;cursor:pointer}` +
    `.muted{color:#666}form{margin-top:1.5rem}` +
    `label{display:block;margin-bottom:1rem}label span{display:block;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;color:#888;margin-bottom:.25rem}` +
    `input,select,textarea{font:inherit;width:100%;box-sizing:border-box;padding:.55rem .7rem;border:1px solid #d0d0d0;border-radius:.5rem}` +
    `.actions{margin-top:1.5rem}</style></head><body>${body}</body></html>`;
}

function messagePage(title: string, detail: string): string {
  return shell(title, `<h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(detail)}</p>`);
}

/**
 * The confirm page. Zero parameters → one button that POSTs (the GET-never-
 * writes rule made visible: following the link does nothing until you act).
 * Parameterized → one control per declared parameter, driven by the stored
 * signature, in declaration order.
 */
function confirmPage(callback: CallbackRecord): string {
  const action = `/api/cb/${encodeURIComponent(callback.id)}`;
  if (callback.params.length === 0) {
    return shell(
      'Confirm',
      `<h1>Confirm this action</h1>` +
        `<p class="muted">This carries on a workflow that is waiting on you.</p>` +
        `<form method="post" action="${action}"><button type="submit">Confirm</button></form>`,
    );
  }
  const fields = callback.params.map(paramControl).join('');
  return shell(
    'Confirm',
    `<h1>Confirm this action</h1>` +
      `<p class="muted">This carries on a workflow that is waiting on you.</p>` +
      `<form method="post" action="${action}">${fields}` +
      `<div class="actions"><button type="submit">Confirm</button></div></form>`,
  );
}

/** One control per parameter, typed from the signature — so what the page can
 *  submit and what the router will accept are derived from ONE declaration. */
function paramControl(param: CallbackParamSpec): string {
  const name = escapeHtml(param.name);
  const label = `<span>${name}</span>`;
  switch (param.type) {
    case 'boolean':
      return `<label>${label}<select name="${name}"><option value="true">Yes</option><option value="false">No</option></select></label>`;
    case 'number':
      return `<label>${label}<input type="number" step="any" name="${name}" required></label>`;
    case 'date':
      return `<label>${label}<input type="date" name="${name}" required></label>`;
    case 'datetime':
      return `<label>${label}<input type="datetime-local" name="${name}" required></label>`;
    case 'json':
      return `<label>${label}<textarea name="${name}" rows="4" required placeholder="{ }"></textarea></label>`;
    case 'file':
      // A file parameter is a handle the CALLING SYSTEM owns. Say so rather
      // than rendering a control that could only submit something wrong.
      return `<label>${label}<input type="text" name="${name}" required placeholder="supplied by the calling system"></label>`;
    case 'text':
      return `<label>${label}<input type="text" name="${name}" required></label>`;
  }
}
