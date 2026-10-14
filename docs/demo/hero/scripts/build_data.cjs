// .work/capture/*  →  data.js, the only input the video page reads. Nothing
// in the video's code, diagnostics or run figures is written by hand.
const fs = require('fs');
const path = require('path');

const HERE = path.join(__dirname, '..');
const CAP = path.join(HERE, '.work', 'capture');
const read = (f) => JSON.parse(fs.readFileSync(path.join(CAP, f), 'utf8'));

const draft = read('10_save_draft.json');
const fixed = read('11_save_fixed.json');
const run = read('40_inspect.json');
const payload = run.sourceEvent.payload;

const data = {
  v1: fs.readFileSync(path.join(HERE, 'programs', 'draft.mvt'), 'utf8').trimEnd(),
  v2: fs.readFileSync(path.join(HERE, 'programs', 'fixed.mvt'), 'utf8').trimEnd(),
  diagnostics: draft.diagnostics,
  validatedUnder: draft.validatedUnder,
  saved: { ok: fixed.ok, listeners: fixed.listeners.map((l) => ({ kind: l.kind, config: l.config })) },
  run: {
    status: run.status,
    committed: run.committed,
    costUsd: run.costUsd,
    modelCalls: run.modelCalls,
    ms: Date.parse(run.finishedAt) - Date.parse(run.startedAt),
    // The program makes one extraction (`extractOne(…, Pitch, { tier: 'quick' })`).
    extract: run.modelCalls > 0 ? { label: 'Pitch', target: 'quick tier' } : undefined,
    email: {
      from: payload.from,
      subject: payload.subject,
      labels: payload.labels,
      body: String(payload.bodyText).replace(/\\n/g, '\n'),
    },
    writes: run.writes.map((w) => ({ target: w.target, action: w.action, values: w.values })),
  },
};

if (data.run.status !== 'success') throw new Error(`run did not succeed: ${run.failureReason}`);
if (data.diagnostics.filter((d) => d.severity === 'error').length !== 1) {
  throw new Error('the draft should be refused with exactly one error');
}
fs.writeFileSync(path.join(HERE, 'data.js'), `window.DEMO=${JSON.stringify(data, null, 1)};\n`);
console.log(`data.js: ${data.run.committed} writes, ${data.run.modelCalls} model call(s), $${data.run.costUsd}, ${data.run.ms} ms`);
