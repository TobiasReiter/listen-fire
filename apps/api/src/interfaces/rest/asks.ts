// Public capability-link route — `GET/POST /api/asks/:token`.
//
// The human answer surface for a parked `ask` (async user interaction, 3d /
// §4.7 stage 1). The single-use token IS the authorisation, so this mounts
// BEFORE the auth middleware (like the files / webhook-sync routes). It never
// touches a credential.
//
//   GET  /api/asks/:token            → render the question + the family-matched
//                                      answer control (the page is SELF-SUFFICIENT:
//                                      a Slack text message or an email can only
//                                      carry the link, so the link must be enough)
//   GET  /api/asks/:token?answer=v   → render a CONFIRM step (never resolves —
//                                      prefetch safety, 3d: a link-unfurl GET
//                                      must not silently fire an answer)
//   POST /api/asks/:token            → resolve: { answer } body → recordAnswer →
//                                      the resume worker drives the run forward
//
// Prefetch safety is the load-bearing property: ONLY a POST resolves. A GET —
// bare or param-bearing — only ever renders HTML. Block-Kit URL buttons (which
// Slack does not unfurl) carry `?answer=`; the confirm page turns the click into
// the resolving POST.
//
// Controls by interaction family (each posts the same payload the engine's
// `validateAnswer` expects — the shapes the web renderer and MCP submitReview
// use, all converging on `recordAnswer`):
//   Check          → Approve / Decline           → boolean
//   Choose / Pick  → a button per offered option → the option id
//   Select         → a checklist                 → the chosen option ids
//   Provide        → a typed input               → the value
//   Correct        → editable record cards       → { rows, dropped }
//   Review / Notify→ a single acknowledge        → "ack"
//   Draft          → app-only notice (the rich editor is a later chunk)
//
// (asks-as-adapter fast-follow, new-store bridge below: `Form` gets its own
// control here — a plain text input per declared field, POSTed as one object
// — since Form has no legacy control to mirror; §B "record-level shape faithfully".)
//
// A closed / spent link renders the TERMINAL state — the recorded answer when
// there is one — never a live control (resolution is idempotent at
// `recordAnswer`; this page mirrors that).

import { Router } from 'express';

import type { Request, Response } from 'express';

import {
  readAskOptions,
  readAskCorrect,
  toAskDetail,
  isParamResolvable,
  isRichRenderable,
  type AskView,
  type AskOption,
  type AskCorrect,
  type RecordedAnswer,
} from '../../services/interaction/answer_surfaces';
import {
  lookupAskByToken,
  type AskFamily,
  type AskRecord,
} from '../../services/translation_graph/adapters/ask/store';
import { answerAskByToken } from '../../services/translation_graph/adapters/ask/answer_door';
import { askResultType, FAMILY_TO_INTERACTION } from '../../services/translation_graph/adapters/ask/surface_view';

const asksRouter: ReturnType<typeof Router> = Router();

// ── New-store bridge (asks-as-adapter) ─────────────────────────────────────
// The SAME public route serves the new ask store and the legacy one. New-store
// tokens carry a stable `ask_` prefix, so the legacy path never runs an extra
// query and stays byte-identical: only a prefixed token is looked up here, and
// only a hit diverts. The new store reuses this file's family-matched controls
// and terminal renderings via a small AskView projection.

/** The families whose offered choices/field-names ride the ask's `options`
 *  column (see store.ts) — Choose/Select offer choices, Form names the fields
 *  it collects; all render as an `options` array in `args`. */
const OPTIONS_FAMILIES = new Set<AskFamily>(['Choose', 'Select', 'Form']);

/** Project a new-store ask into the AskView the local renderers consume. */
function newAskToView(ask: AskRecord): AskView {
  const interactionType = FAMILY_TO_INTERACTION[ask.family];
  const options = OPTIONS_FAMILIES.has(ask.family)
    ? (ask.options ?? []).map((o) => ({ id: o, label: o, value: o }))
    : undefined;
  const correct =
    ask.family === 'Correct' && ask.rows
      ? { rows: ask.rows.map((r) => ({ ephemeralId: r.ephemeralId, fields: r.fields })) }
      : undefined;
  return {
    // The ask id IS the surface handle now (we resolve via answerAsk).
    requestId: ask.id,
    teamId: ask.teamId,
    interactionType,
    resultType: askResultType(ask),
    args: {
      title: ask.prompt,
      ...(ask.detail != null ? { detail: ask.detail } : {}),
      ...(options !== undefined ? { options } : {}),
      ...(correct !== undefined ? { correct } : {}),
    },
    status: ask.state === 'open' ? 'open' : ask.state,
    paramResolvable: isParamResolvable(interactionType),
    richRenderable: isRichRenderable(interactionType),
  };
}

/** A terminal (settled or dead-token) rendering for a new-store ask — closed
 *  request wins, exactly like the legacy page. Returns null when the ask is
 *  still answerable. */
function newAskTerminal(ask: AskRecord): { status: number; html: string } | null {
  if (ask.state === 'answered') {
    return {
      status: 410,
      html: unavailablePage('already_resolved', {
        recorded: { interactionType: FAMILY_TO_INTERACTION[ask.family], answer: ask.answer },
      }),
    };
  }
  // A CLOSED ask (`expired` state) is not an expired LINK: the request itself
  // was withdrawn — cancelled by its movement, or abandoned when the run that
  // asked it ended (a lost race arm, a failed run, a retired listener). Telling
  // someone to "request a fresh one" would be wrong; there is nothing to
  // re-request, and nothing is waiting on them.
  if (ask.state === 'expired') {
    return { status: 410, html: closedRequestPage() };
  }
  if (ask.tokenExpiresAt.getTime() <= Date.now()) {
    return { status: 410, html: unavailablePage('expired') };
  }
  return null;
}

/** The terminal page a CLOSED (withdrawn) ask renders — the request is gone,
 *  not the link. */
function closedRequestPage(): string {
  return messagePage(
    'This request was closed',
    'This request is no longer open — nothing is waiting on an answer to it. Nothing more is needed here.',
  );
}

// GET …/detail — JSON. The web `/a/<token>` page (the universal renderer, 6b)
// fetches this to render the question + the right control per interaction type.
// Same token verification as the HTML route; 404/410 for a bad/gone token.
// This is a READ (no resolve) — prefetch-safe by construction.
asksRouter.get('/:token/detail', async (req: Request, res: Response) => {
  const newAsk = await lookupAskByToken(req.params.token);
  if (newAsk) {
    const terminal = newAskTerminal(newAsk);
    if (terminal) {
      res.status(terminal.status).json({ error: newAsk.state === 'answered' ? 'already_resolved' : 'expired' });
      return;
    }
    res.status(200).json(toAskDetail(newAskToView(newAsk)));
    return;
  }
  // A non-new-store token is a LEGACY link — the legacy ask store is gone
  // (asks-as-adapter chunk G). Its links are closed.
  res.status(410).json({ error: 'closed' });
});

// GET — render only. Never resolves (prefetch safety).
asksRouter.get('/:token', async (req: Request, res: Response) => {
  const token = req.params.token;

  const newAsk = await lookupAskByToken(token);
  if (newAsk) {
    const terminal = newAskTerminal(newAsk);
    if (terminal) {
      res.status(terminal.status).type('html').send(terminal.html);
      return;
    }
    const answerParam = typeof req.query.answer === 'string' ? req.query.answer : undefined;
    res.status(200).type('html').send(askPage(token, newAskToView(newAsk), answerParam));
    return;
  }

  // A legacy (non-new-store) link — its store is gone; render the closed page.
  res.status(410).type('html').send(closedPage());
});

// POST — the only resolving door. The controls (and the confirm form) post here.
asksRouter.post('/:token', async (req: Request, res: Response) => {
  const token = req.params.token;
  const answer = readAnswer(req);
  if (answer === undefined) {
    res.status(400).type('html').send(messagePage('Missing answer', 'No answer was supplied.'));
    return;
  }

  const newAsk = await lookupAskByToken(token);
  if (newAsk) {
    const terminal = newAskTerminal(newAsk);
    if (terminal) {
      res.status(terminal.status).type('html').send(terminal.html);
      return;
    }
    // The ONE answer door — the same transition the Slack interactivity route
    // and the MCP submit drive (5_build_order Ops decisions).
    const outcome = await answerAskByToken(token, answer);
    if (outcome.kind === 'answered') {
      res
        .status(200)
        .type('html')
        .send(confirmedPage(FAMILY_TO_INTERACTION[newAsk.family], outcome.ask.answer));
      return;
    }
    if (outcome.kind === 'invalid') {
      res
        .status(400)
        .type('html')
        .send(unavailablePage('invalid', { detail: outcome.message }));
      return;
    }
    // Settled/expired mid-flight (or vanished) — closed request wins.
    const settled = outcome.kind === 'closed' ? outcome.ask : newAsk;
    const term = newAskTerminal(settled) ?? { status: 410, html: unavailablePage('already_resolved') };
    res.status(term.status).type('html').send(term.html);
    return;
  }

  // A legacy (non-new-store) link — its store is gone; the request is closed.
  res.status(410).type('html').send(closedPage());
});

/** The terminal page a LEGACY capability link now renders — the legacy ask
 *  store was deleted (asks-as-adapter chunk G), so every old link is closed. */
function closedPage(): string {
  return messagePage(
    'This request was closed',
    'This request is no longer open — it was handled through the workflow. Nothing more is needed here.',
  );
}

/** Pull the answer from a POST: JSON body, urlencoded form, or `?answer=`
 *  (the confirm form posts the value back). Returns the RAW value —
 *  `recordAnswer` validates + coerces it against the result type. */
function readAnswer(req: Request): unknown {
  const body = req.body as Record<string, unknown> | undefined;
  if (body && Object.prototype.hasOwnProperty.call(body, 'answer')) return body.answer;
  if (typeof req.query.answer === 'string') return req.query.answer;
  return undefined;
}

// ── HTML (minimal, self-contained — no external assets, works from any channel) ──

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
    `button:disabled{opacity:.5;cursor:default}button.secondary{background:#fff;color:#111}` +
    `.muted{color:#666}form{margin-top:1.5rem}.row{display:flex;gap:.5rem}` +
    `.stack{display:flex;flex-direction:column;gap:.5rem;align-items:stretch}.stack button{text-align:left}` +
    `input[type=text],input[type=number],input[type=date]{font:inherit;width:100%;box-sizing:border-box;padding:.55rem .7rem;border:1px solid #d0d0d0;border-radius:.5rem}` +
    `.options{border:1px solid #e3e3e3;border-radius:.75rem;overflow:hidden;margin-bottom:1rem}` +
    `.opt{display:flex;gap:.6rem;align-items:center;padding:.7rem 1rem;border-top:1px solid #eee;cursor:pointer}.opt:first-child{border-top:0}` +
    `.card{border:1px solid #e3e3e3;border-radius:.75rem;padding:1rem;margin-bottom:.75rem}.card.removed{opacity:.45}` +
    `.card-head{display:flex;justify-content:space-between;align-items:center;gap:.75rem;font-weight:500}` +
    `.field{display:block;margin-top:.6rem}.field span{display:block;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;color:#888;margin-bottom:.25rem}` +
    `.linkbtn{background:none;border:0;color:#666;cursor:pointer;font:inherit;font-size:.8rem;text-decoration:underline;padding:0}` +
    `.actions{margin-top:1.5rem}</style></head><body>${body}</body></html>`;
}

function askTitle(ask: AskView): string {
  const t = ask.args.title;
  return typeof t === 'string' && t.trim() !== '' ? t : 'A response is needed';
}

function askHeading(ask: AskView): string {
  const detail = typeof ask.args.detail === 'string' ? ask.args.detail : undefined;
  return (
    `<h1>${escapeHtml(askTitle(ask))}</h1>` +
    (detail !== undefined ? `<p class="muted">${escapeHtml(detail)}</p>` : '')
  );
}

/** The answer page. A param-bearing, resolvable answer (a Slack Block-Kit URL
 *  button) → a one-click confirm that POSTs (prefetch-safe). Otherwise → the
 *  live control matched to the interaction family — the page is self-sufficient,
 *  since a link-only channel (a Slack text message, an email) can deliver
 *  nothing but this URL. */
function askPage(token: string, ask: AskView, answerParam: string | undefined): string {
  const action = `/api/asks/${encodeURIComponent(token)}`;

  if (answerParam !== undefined && ask.paramResolvable) {
    return shell(
      'Confirm your answer',
      `${askHeading(ask)}<p>You're about to answer: <strong>${escapeHtml(answerParam)}</strong></p>` +
        `<form method="post" action="${action}">` +
        `<input type="hidden" name="answer" value="${escapeHtml(answerParam)}">` +
        `<button type="submit">Confirm</button></form>` +
        `<p class="muted">This records your answer and resumes the workflow.</p>`,
    );
  }

  // Bare link (or a param the type can't resolve — ignored): the live control.
  return shell('Respond', askHeading(ask) + controlHtml(action, ask));
}

/** The family-matched control. Each posts the same answer payload the web
 *  renderer submits (`ask-controls.tsx`) — one validation contract server-side. */
function controlHtml(action: string, ask: AskView): string {
  switch (ask.interactionType.toLowerCase()) {
    case 'check':
      return checkControl(action);
    case 'choose':
    case 'pick':
      return chooseControl(action, readAskOptions(ask.args) ?? []);
    case 'select':
      return selectControl(action, readAskOptions(ask.args) ?? []);
    case 'provide':
      return provideControl(action, ask.resultType.graph);
    case 'correct':
      return correctControl(action, readAskCorrect(ask.args));
    case 'form':
      return formControl(action, readAskOptions(ask.args) ?? []);
    case 'review':
    case 'notify':
      return acknowledgeControl(action);
    default:
      // Draft — the rich editor lives in the app (a later chunk).
      return (
        `<p class="muted">This response is put together in the Listen-Fire app, where you can ` +
        `review and edit the details.</p>`
      );
  }
}

function checkControl(action: string): string {
  return (
    `<form method="post" action="${action}" class="row">` +
    `<button type="submit" name="answer" value="true">Approve</button>` +
    `<button type="submit" name="answer" value="false" class="secondary">Decline</button>` +
    `</form>`
  );
}

function chooseControl(action: string, options: AskOption[]): string {
  if (options.length === 0) {
    return `<p class="muted">There's nothing to choose from here.</p>`;
  }
  const buttons = options
    .map(
      (opt) =>
        `<button type="submit" name="answer" value="${escapeHtml(opt.id)}" class="secondary">` +
        `${escapeHtml(opt.label)}</button>`,
    )
    .join('');
  return `<form method="post" action="${action}" class="stack">${buttons}</form>`;
}

function selectControl(action: string, options: AskOption[]): string {
  if (options.length === 0) {
    return `<p class="muted">There's nothing to choose from here.</p>`;
  }
  const boxes = options
    .map(
      (opt) =>
        `<label class="opt"><input type="checkbox" name="answer" value="${escapeHtml(opt.id)}">` +
        `${escapeHtml(opt.label)}</label>`,
    )
    .join('');
  // The hidden empty field makes an empty selection submittable (the engine
  // drops empty ids), so "none of these" is a valid, expressible answer.
  return (
    `<form method="post" action="${action}">` +
    `<input type="hidden" name="answer" value="">` +
    `<div class="options">${boxes}</div>` +
    `<button type="submit">Submit selection</button></form>`
  );
}

function provideControl(action: string, graph: string): string {
  // A boolean result type has no meaningful free-text form — same Yes/No
  // buttons as Check, so the posted value hits the same string→boolean decode.
  if (graph === 'boolean') {
    return (
      `<form method="post" action="${action}" class="row">` +
      `<button type="submit" name="answer" value="true">Yes</button>` +
      `<button type="submit" name="answer" value="false" class="secondary">No</button>` +
      `</form>`
    );
  }
  const inputType = graph === 'number' ? 'number' : graph === 'date' ? 'date' : 'text';
  const step = inputType === 'number' ? ' step="any"' : '';
  const placeholder =
    inputType === 'number' ? 'Enter a number' : inputType === 'date' ? '' : 'Type your answer';
  return (
    `<form method="post" action="${action}">` +
    `<input type="${inputType}"${step} name="answer" required placeholder="${placeholder}" autofocus>` +
    `<div class="actions"><button type="submit">Submit</button></div></form>`
  );
}

function acknowledgeControl(action: string): string {
  return (
    `<form method="post" action="${action}">` +
    `<button type="submit" name="answer" value="ack">Got it</button></form>`
  );
}

/** A `Form` ask's named fields, one plain text input each — the record-level
 *  approximation of the legacy composite ask (no per-field typed control,
 *  since that needs the never-built composite engine; see store.ts). A small
 *  inline script (mirroring `correctScript`) collects every field into one
 *  object and POSTs it as JSON — the answer must supply a value for each. */
function formControl(action: string, options: AskOption[]): string {
  if (options.length === 0) {
    return `<p class="muted">There's nothing to fill in here.</p>`;
  }
  const inputs = options
    .map(
      (opt) =>
        `<label class="field"><span>${escapeHtml(opt.label)}</span>` +
        `<input type="text" data-field="${escapeHtml(opt.id)}"></label>`,
    )
    .join('');
  const data = { action, fields: options.map((o) => o.id) };
  return (
    `<div id="form-fields">${inputs}</div>` +
    `<div class="actions"><button type="button" id="form-submit">Submit</button>` +
    `<p class="muted" id="form-error" hidden>Could not record your answer. Try again.</p></div>` +
    `<script>${formScript(data)}</script>`
  );
}

function formScript(data: { action: string; fields: string[] }): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return (
    `(function(){` +
    `var DATA=${json};` +
    `document.getElementById('form-submit').addEventListener('click',function(){` +
    `var submit=this;var answer={};` +
    `DATA.fields.forEach(function(name){` +
    `var input=document.querySelector('[data-field="'+CSS.escape(name)+'"]');` +
    `answer[name]=input?input.value:'';` +
    `});` +
    `submit.disabled=true;` +
    `fetch(DATA.action,{method:'POST',headers:{'Content-Type':'application/json'},` +
    `body:JSON.stringify({answer:answer})})` +
    `.then(function(res){return res.text();})` +
    `.then(function(html){document.open();document.write(html);document.close();})` +
    `.catch(function(){submit.disabled=false;document.getElementById('form-error').hidden=false;});` +
    `});` +
    `})();`
  );
}

/** Editable record cards for a `Correct` ask. The only JS-assisted control —
 *  the answer is structured (`{ rows, dropped }`), so a small inline script
 *  collects the edits (changed cells only, numbers kept numeric — mirroring the
 *  web control) and POSTs JSON, then renders the response page. */
function correctControl(action: string, correct: AskCorrect | undefined): string {
  if (!correct || correct.rows.length === 0) {
    return `<p class="muted">There's nothing to review here.</p>`;
  }

  const cards = correct.rows
    .map((row) => {
      const fields = correct.columns
        .filter((column) => column in row.fields)
        .map(
          (column) =>
            `<label class="field"><span>${escapeHtml(column)}</span>` +
            `<input type="text" data-col="${escapeHtml(column)}" value="${escapeHtml(fieldText(row.fields[column]))}">` +
            `</label>`,
        )
        .join('');
      return (
        `<div class="card" data-card="${escapeHtml(row.ephemeralId)}">` +
        `<div class="card-head"><span>${escapeHtml(row.label || 'Record')}</span>` +
        `<button type="button" class="linkbtn" data-toggle>Remove</button></div>` +
        `${fields}</div>`
      );
    })
    .join('');

  const data = {
    action,
    rows: correct.rows.map((r) => ({ ephemeralId: r.ephemeralId, fields: r.fields })),
  };

  return (
    `<div id="correct">${cards}</div>` +
    `<div class="actions"><button type="button" id="correct-submit">Save and continue</button>` +
    `<p class="muted" id="correct-error" hidden>Could not record your answer. Try again.</p></div>` +
    `<script>${correctScript(data)}</script>`
  );
}

/** Render a field value as the text its input shows (mirrors the web control). */
function fieldText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function correctScript(data: { action: string; rows: Array<{ ephemeralId: string; fields: Record<string, unknown> }> }): string {
  // `<` escaped so a value containing `</script>` can't break out of the tag.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return (
    `(function(){` +
    `var DATA=${json};` +
    `var originals={};DATA.rows.forEach(function(r){originals[r.ephemeralId]=r.fields;});` +
    `function text(v){if(v===null||v===undefined)return'';if(typeof v==='object')return JSON.stringify(v);return String(v);}` +
    `document.querySelectorAll('[data-card]').forEach(function(card){` +
    `var btn=card.querySelector('[data-toggle]');` +
    `btn.addEventListener('click',function(){` +
    `var removed=card.classList.toggle('removed');` +
    `btn.textContent=removed?'Keep':'Remove';` +
    `card.querySelectorAll('input[data-col]').forEach(function(inp){inp.disabled=removed;});` +
    `});});` +
    `document.getElementById('correct-submit').addEventListener('click',function(){` +
    `var submit=this;var rows=[];var dropped=[];` +
    `document.querySelectorAll('[data-card]').forEach(function(card){` +
    `var id=card.getAttribute('data-card');` +
    `if(card.classList.contains('removed')){dropped.push(id);return;}` +
    `var fields={};` +
    `card.querySelectorAll('input[data-col]').forEach(function(inp){` +
    `var col=inp.getAttribute('data-col');var original=(originals[id]||{})[col];` +
    `if(inp.value===text(original))return;` +
    `var value=inp.value;` +
    `if(typeof original==='number'&&value.trim()!==''&&isFinite(Number(value)))value=Number(value);` +
    `fields[col]=value;` +
    `});` +
    `rows.push({ephemeralId:id,fields:fields});` +
    `});` +
    `submit.disabled=true;` +
    `fetch(DATA.action,{method:'POST',headers:{'Content-Type':'application/json'},` +
    `body:JSON.stringify({answer:{rows:rows,dropped:dropped}})})` +
    `.then(function(res){return res.text();})` +
    `.then(function(html){document.open();document.write(html);document.close();})` +
    `.catch(function(){submit.disabled=false;document.getElementById('correct-error').hidden=false;});` +
    `});` +
    `})();`
  );
}

/** A human reading of a recorded answer — for the confirmed page and the
 *  terminal already-answered page. */
function describeAnswer(interactionType: string | undefined, answer: unknown): string {
  const kind = interactionType?.toLowerCase();
  if (typeof answer === 'boolean') {
    if (kind === 'check') return answer ? 'Approved' : 'Declined';
    return answer ? 'Yes' : 'No';
  }
  if (answer === 'ack') return 'Acknowledged';
  if (typeof answer === 'string') return answer;
  if (typeof answer === 'number') return String(answer);
  if (Array.isArray(answer)) {
    if (answer.length === 0) return 'Nothing selected';
    if (answer.every((v) => typeof v === 'string' || typeof v === 'number')) {
      return answer.join(', ');
    }
    return `${answer.length} selected`;
  }
  if (answer !== null && typeof answer === 'object' && '__correct' in answer) {
    const rows = (answer as { __correct?: { rows?: unknown[] } }).__correct?.rows;
    if (Array.isArray(rows)) return `${rows.length} record${rows.length === 1 ? '' : 's'} kept`;
  }
  // The new-store `Correct` shape — { rows, dropped } directly, no `__correct`
  // wrapper (that wrapper is a legacy-store-only convention).
  if (answer !== null && typeof answer === 'object' && 'rows' in answer && Array.isArray((answer as { rows: unknown }).rows)) {
    const rec = answer as { rows: unknown[]; dropped?: unknown[] };
    const dropped = Array.isArray(rec.dropped) ? rec.dropped : [];
    const parts = [`${rec.rows.length} row${rec.rows.length === 1 ? '' : 's'} updated`];
    if (dropped.length > 0) parts.push(`${dropped.length} dropped`);
    return parts.join(', ');
  }
  return JSON.stringify(answer);
}

function confirmedPage(interactionType: string | undefined, answer: unknown): string {
  return shell(
    'Answer recorded',
    `<h1>Thanks — your answer was recorded.</h1>` +
      `<p class="muted">Recorded: <strong>${escapeHtml(describeAnswer(interactionType, answer))}</strong>. ` +
      `The workflow will continue shortly.</p>`,
  );
}

function unavailablePage(
  reason: string,
  options: { detail?: string; recorded?: RecordedAnswer } = {},
): string {
  // An answered ask is a terminal STATE, not an error: show what was recorded.
  if (options.recorded !== undefined) {
    const label = describeAnswer(options.recorded.interactionType, options.recorded.answer);
    return shell(
      'Already answered',
      `<h1>This request has already been answered.</h1>` +
        `<p class="muted">Recorded answer: <strong>${escapeHtml(label)}</strong>. ` +
        `Nothing more is needed here.</p>`,
    );
  }

  const map: Record<string, string> = {
    not_found: "This link isn't valid.",
    expired: 'This link has expired. Request a fresh one to answer.',
    consumed: 'This link has already been used.',
    already_resolved: 'This request has already been answered or is no longer open.',
    invalid: 'That answer could not be accepted.',
  };
  const msg = map[reason] ?? 'This request is no longer available.';
  return messagePage('No longer available', options.detail ? `${msg} (${options.detail})` : msg);
}

function messagePage(title: string, body: string): string {
  return shell(title, `<h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(body)}</p>`);
}

export { asksRouter };
