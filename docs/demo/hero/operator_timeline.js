// The business cut of the hero demo: same captured run as timeline.js, told
// without code or tool names. Every visual is a pure function of t (seconds).
// Every name, figure, stage and message comes from data.js; only the user's
// request and Claude's reply are scripted, as in timeline.js.
window.DURATION = 60;
const D = window.DEMO;
const $ = (id) => document.getElementById(id);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (x) => 1 - Math.pow(1 - clamp(x), 3);
const fade = (t, a, b) => ease((t - a) / (b - a));
const win = (t, a, b, c, d) => Math.min(fade(t, a, b), 1 - fade(t, c, d));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function show(el, o, dy = 18, dx = 0) {
  el.style.opacity = o;
  el.style.transform = `translate(${(1 - o) * dx}px, ${(1 - o) * dy}px)`;
  el.style.visibility = o <= 0.001 ? 'hidden' : 'visible';
}
const typed = (text, t, a, b) => text.slice(0, Math.round(text.length * clamp((t - a) / (b - a))));
const CARET = '<span class="caret"></span>';
const SPIN = (t) => `<span class="spin" style="transform:rotate(${t * 540}deg)"></span>`;
const OK = '<span style="color:var(--green)">✓</span>';
const WARN = '<span style="color:var(--amber)">!</span>';

// ── facts read from the captured run (a missing one is a broken capture) ─────
function need(m, what) {
  if (!m) throw new Error(`data.js has no ${what}`);
  return m[1];
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const list = (xs) => (xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);
const PROG = D.v2;
const SYSTEMS = need(PROG.match(/^import \{([^}]+)\} from adapters/m), 'adapter import').split(',').map((s) => cap(s.trim()));
const AUTOMATION = need(PROG.match(/function `([^`]+)`/), 'automation name');
const PROG_LINES = PROG.split('\n').length;
const CHANNEL = need(PROG.match(/Channels WHERE `Name` == "([^"]+)"/), 'Slack channel');
const LABEL = D.saved.listeners[0].config.labels[0];

const ERR = D.diagnostics.find((d) => d.severity === 'error');
const FIELD = need(ERR.sourceLine.slice(0, ERR.col - 1).match(/(\w+):\s*$/), 'field of the error').toLowerCase();
const BAD = need(ERR.sourceLine.slice(ERR.col - 1, ERR.endCol - 1).match(/^"(.*)"$/), 'rejected value');
const GOOD = need(PROG.split('\n')[ERR.line - 1].slice(ERR.col - 1).match(/^"([^"]*)"/), 'corrected value');
const OPTIONS = need(ERR.message.match(/expected one of: (.+?)\.?$/), 'allowed values').split(' | ');

const W = D.run.writes;
const findWrite = (pred, what) => { const w = W.find(pred); if (!w) throw new Error(`data.js run has no ${what} write`); return w; };
const tool = (w) => cap(w.target.split(':')[0]);
const COMPANY = findWrite((w) => /:Companies$/.test(w.target), 'company');
const PERSON = findWrite((w) => /:People$/.test(w.target), 'founder');
const STAGE = findWrite((w) => 'Stage' in w.values, 'stage');
const NOTE = findWrite((w) => /:Note$/.test(w.target), 'note');
const MESSAGE = findWrite((w) => 'Message' in w.values, 'message');
const CRM = tool(STAGE);
const PIPELINE = STAGE.target.split(':')[1];

const CHECKS = [
  ...(D.run.extract ? ['Read the email and pulled out the company'] : []),
  `Added <b>${esc(COMPANY.values.Name)}</b> to ${esc(tool(COMPANY))}`,
  `Added <b>${esc(PERSON.values.Name)}</b> as the founder`,
  `Put it in ${esc(PIPELINE)} at <b>${esc(STAGE.values.Stage)}</b>`,
  'Saved the email as a note',
  `Told the team in <b>#${esc(CHANNEL)}</b>`,
];
const COST = D.run.costUsd < 0.01 ? 'less than a cent' : '$' + D.run.costUsd.toFixed(2);
const RUN_STAT = `Done in <b>${(D.run.ms / 1000).toFixed(1)} seconds</b>, for <b>${COST}</b>.`;

const PROMPT = 'When I label an email “Dealflow” in Gmail, add the company and founder to Attio, put it in VC Deal Flow at Sourcing, save the email as a note, and ping #dealflow.';
const REPLY = `It’s live. From now on, every email you label ${LABEL} goes into ${CRM} and #${CHANNEL}. You don’t need to ask again.`;

// ── timings (seconds) ────────────────────────────────────────────────────────
const T = {
  title: [0.3, 1.0, 3.9, 4.5],
  stage: [4.5, 5.0, 20.4, 21.0], prompt: [5.0, 9.0], agent: 9.4,
  s1: [9.4, 10.6], s2: [10.8, 11.8], catchIn: 11.8, opts: 12.6, use: 14.2,
  reply: [15.6, 16.8], code: 17.2,
  later: [21.0, 21.4, 22.6, 23.0],
  run: [23.0, 23.4, 42.6, 43.2], email: 23.2, done: 25.6, c0: 26.4, cstep: 1.0,
  closing: [43.2, 43.8, 54.8, 55.4], cols: [44.0, 45.2, 46.4], stat: 48.0,
  end: 55.6,
};
const CHECKS_DONE = T.c0 + T.cstep * (CHECKS.length - 1) + 0.4;
const R1 = CHECKS_DONE + 0.4, R3 = R1 + 1.2, STAT = R3 + 1.2;

const CAPTIONS = [
  [5.2, 9.6, 'Ask for what you want, in plain English.'],
  [23.6, 27.4, `A founder emails in. You label it ${esc(LABEL)}.`],
];

function step(el, t, [a, b], text, end) {
  show(el, fade(t, a, a + 0.35), 10);
  el.querySelector('.st').innerHTML = t < b ? SPIN(t) : end;
  el.querySelector('.tx').textContent = text;
}

function seek(t) {
  show($('t1'), win(t, ...T.title), 24);
  show($('t2'), win(t, 1.4, 2.1, T.title[2], T.title[3]), 24);

  // ask
  const so = win(t, ...T.stage);
  show($('stage'), so, 0);
  if (so > 0) {
    $('ubub').innerHTML = esc(typed(PROMPT, t, ...T.prompt)) + (t < T.prompt[1] + 0.3 ? CARET : '');
    show($('agent'), fade(t, T.agent, T.agent + 0.4), 12);
    step($('s1'), t, T.s1, `Looking at your ${list(SYSTEMS)}`, OK);
    step($('s2'), t, T.s2, `Checking the setup against your ${CRM}`, t < T.use ? WARN : OK);

    show($('catch'), fade(t, T.catchIn, T.catchIn + 0.5), 12);
    $('cline').innerHTML = `${esc(CRM)} doesn’t have a ${esc(FIELD)} called “${esc(BAD)}”.`;
    const picked = t >= T.use;
    $('copts').style.opacity = fade(t, T.opts, T.opts + 0.4);
    $('copts').innerHTML = `<span>Your ${esc(FIELD)}s are:</span>` +
      OPTIONS.map((o) => `<span class="opt${picked && o === GOOD ? ' pick' : ''}">${esc(o)}</span>`).join('');
    show($('cuse'), fade(t, T.use, T.use + 0.4), 8);
    $('cuse').innerHTML = `Using “<b>${esc(GOOD)}</b>”.`;

    show($('abub'), fade(t, T.reply[0], T.reply[0] + 0.3), 10);
    $('abub').innerHTML = esc(typed(REPLY, t, ...T.reply));
    show($('codecard'), fade(t, T.code, T.code + 0.5), 8);
    $('codecard').innerHTML = `<span class="ic">{ }</span><b>${esc(AUTOMATION)}</b><span>·</span><span>${PROG_LINES} lines</span><span>·</span><span class="view">view</span>`;
  }

  show($('later'), win(t, ...T.later), 0);

  // it happens
  const ro = win(t, ...T.run);
  show($('runstage'), ro, 0);
  if (ro > 0) {
    const e = D.run.email;
    const m = e.from.match(/^(.*?)\s*<(.+)>$/);
    $('efrom').textContent = m[1]; $('eaddr').textContent = m[2];
    $('esubj').textContent = e.subject; $('ebody').textContent = e.body;
    $('elabel').textContent = LABEL;
    show($('email'), fade(t, T.email, T.email + 0.6), 0, -40);

    show($('done'), fade(t, T.done, T.done + 0.4), 14);
    const finished = t >= CHECKS_DONE;
    $('dtitle').innerHTML = finished
      ? `${OK}&nbsp; ${esc(AUTOMATION)} · ${D.run.status === 'success' ? 'done' : esc(D.run.status)}`
      : `${SPIN(t)}<span>${esc(AUTOMATION)} · working</span>`;
    $('checks').innerHTML = CHECKS.map((c, i) => {
      const o = fade(t, T.c0 + i * T.cstep, T.c0 + i * T.cstep + 0.35);
      return `<div class="ck" style="opacity:${o}"><span class="ok">✓</span><span>${c}</span></div>`;
    }).join('');

    show($('r1'), fade(t, R1, R1 + 0.5), 0, 40);
    $('r1lbl').textContent = `${tool(COMPANY)} · ${COMPANY.target.split(':')[1]}`;
    const cv = COMPANY.values;
    $('r1kv').innerHTML =
      `<span>Name</span><span>${esc(cv.Name)}</span>` +
      `<span>Domains</span><span>${esc(cv.Domains)}</span>` +
      (cv.Description ? `<span>Description</span><span>${esc(cv.Description)}</span>` : '') +
      `<span>Team</span><span>${esc(PERSON.values.Name)} · ${esc(PERSON.values.Email)}</span>` +
      `<span>${esc(PIPELINE)}</span><span><span class="pill" style="background:rgba(74,222,128,.15);color:var(--green)">${esc(STAGE.values.Stage)}</span></span>`;
    show($('r3'), fade(t, R3, R3 + 0.5), 0, 40);
    $('r3lbl').textContent = `${tool(MESSAGE)} · #${CHANNEL}`;
    $('r3tx').textContent = MESSAGE.values.Message;
    show($('runstat'), fade(t, STAT, STAT + 0.5), 14);
    $('runstat').innerHTML = RUN_STAT;
  }

  // closing
  const co = win(t, ...T.closing);
  show($('closing'), co, 0);
  ['k1', 'k2', 'k3'].forEach((id, i) => show($(id), fade(t, T.cols[i], T.cols[i] + 0.5) * co, 20));
  show($('stat'), fade(t, T.stat, T.stat + 0.5) * co, 14);
  show($('endmark'), fade(t, T.end, T.end + 0.7), 20);

  // chrome
  show($('footer'), win(t, T.stage[0], T.stage[1], T.run[2], T.run[3]), 0);
  const c = CAPTIONS.find(([a, b]) => t >= a - 0.01 && t <= b);
  const capEl = $('caption');
  if (c) { capEl.innerHTML = c[2]; show(capEl, win(t, c[0], c[0] + 0.3, c[1] - 0.3, c[1]), 10); }
  else show(capEl, 0, 0);
}
window.seek = seek;
seek(0);
