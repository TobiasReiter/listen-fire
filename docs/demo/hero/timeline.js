// Every visual is a pure function of t (seconds), so render.cjs can capture
// frames deterministically. All program text, diagnostics and run figures
// come from data.js, which is generated from the captured MCP responses.
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
function fmtCost(c) { return c === 0 ? '$0' : c < 0.01 ? '$' + c.toFixed(4) : '$' + c.toFixed(2); }
const CARET = '<span class="caret"></span>';

// ── syntax highlighting (enough for the demo's program) ─────────────────────
const TOKEN = /(#.*$)|("(?:[^"\\]|\\.)*")|(-\[[^\]]*\]->)|(`[^`]*`)|\b(import|from|function|node|write|listen|to|fire|unique|by|if|null)\b|((?:[A-Z][A-Z_]*(?:\.[A-Z_]+)?|extractOne|extract)(?=\())/g;
function hl(src) {
  let out = '', last = 0, m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(src))) {
    out += esc(src.slice(last, m.index));
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'e' : m[4] ? 'b' : m[5] ? 'k' : 'f';
    out += `<span class="tk-${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(src.slice(last));
}

// ── the program ─────────────────────────────────────────────────────────────
const LINES = D.v1.split('\n');
const ERR = D.diagnostics.find((d) => d.severity === 'error');
const ERR_LINE = ERR.line - 1;
const BAD = '"Sourcing"', GOOD = '"Sourced"';
const UNIQUE = LINES.map((l, i) => (/unique by/.test(l) ? i : -1)).filter((i) => i >= 0);
const TOTAL = LINES.reduce((n, l) => n + l.length + 1, 0);

// timings
const T = {
  stageIn: 5.0, prompt: [5.6, 9.6], agent: 10.0, c1: [10.0, 10.8], c2: [11.0, 11.6],
  stream: [13.6, 19.6], c3: [20.0, 20.8], err: 20.8, fix: [27.5, 28.1, 28.2, 28.6],
  dedupe: [28.6, 29.2, 29.9], c4: [30.6, 31.3], abub: [31.6, 33.6], stageOut: [35.4, 36.0],
};

function renderCode(t) {
  const streamed = TOTAL * clamp((t - T.stream[0]) / (T.stream[1] - T.stream[0]));
  const streaming = t >= T.stream[0] && t < T.stream[1];
  let used = 0, html = '';
  const errOn = t >= T.err && t < T.fix[0];
  for (let i = 0; i < LINES.length; i++) {
    let line = LINES[i];
    const avail = streamed - used;
    used += line.length + 1;
    if (avail <= 0) break;
    const visible = line.slice(0, Math.max(0, Math.floor(avail)));
    const isTail = streaming && avail < line.length + 1;
    let body, cls = '', h = 23, op = 1, suffix = '';

    if (i === ERR_LINE && t >= T.err) {
      const at = line.indexOf(BAD);
      let tok = BAD, caret = '';
      if (t >= T.fix[0]) {
        // backspace "ing\"" then type "ed\"": a one-token edit, as editAutomation makes it
        const del = Math.round(4 * clamp((t - T.fix[0]) / (T.fix[1] - T.fix[0])));
        const add = Math.round(3 * clamp((t - T.fix[2]) / (T.fix[3] - T.fix[2])));
        tok = BAD.slice(0, BAD.length - del) + 'ed"'.slice(0, add);
        if (t < T.fix[3] + 0.4) caret = CARET;
        cls = t < T.c4[1] ? 'fixhl' : '';
      }
      const tokHtml = `<span class="tk-s${errOn ? ' squig' : ''}">${esc(tok)}</span>${caret}`;
      body = hl(line.slice(0, at)) + tokHtml + hl(line.slice(at + BAD.length));
      if (errOn) cls = 'hl';
    } else if (UNIQUE.includes(i) && t >= T.dedupe[0]) {
      const k = fade(t, T.dedupe[1], T.dedupe[2]);
      h = 23 * (1 - k); op = 1 - k;
      suffix = `<span style="color:var(--blue);opacity:${fade(t, T.dedupe[0], T.dedupe[0] + 0.3)}">   ← Attio already de-duplicates on this</span>`;
      body = hl(visible) + suffix;
      if (h < 0.5) continue;
    } else {
      body = hl(visible) + (isTail ? CARET : '');
    }
    const removed = t >= T.dedupe[2] ? UNIQUE.filter((u) => u < i).length : 0;
    html += `<div class="ln ${cls}" style="height:${h}px;opacity:${op}"><span class="g">${i + 1 - removed}</span><span>${body}</span></div>`;

    if (i === ERR_LINE && t >= T.err) {
      const k = Math.min(fade(t, T.err, T.err + 0.5), 1 - fade(t, T.fix[0] - 0.4, T.fix[0]));
      if (k > 0.001) {
        html += `<div class="diag" style="max-height:${110 * k}px;opacity:${k}"><div class="code">${esc(ERR.code)} · line ${ERR.line}</div>${esc(ERR.message)}</div>`;
      }
    }
  }
  const code = $('code');
  code.innerHTML = html;
  const room = $('codeclip').clientHeight;
  const over = Math.max(0, code.scrollHeight - room);
  code.style.transform = `translateY(${-over}px)`;

  const st = $('edstatus');
  if (t >= T.c4[1]) { st.innerHTML = '● Live · Gmail, label “Dealflow”'; st.style.color = 'var(--green)'; }
  else if (t >= T.c4[0]) { st.textContent = 'checking against your systems…'; st.style.color = 'var(--dim)'; }
  else if (t >= T.fix[0]) { st.textContent = 'editing'; st.style.color = 'var(--dim)'; }
  else if (t >= T.err) { st.textContent = '1 error · not saved'; st.style.color = 'var(--red)'; }
  else if (t >= T.c3[0]) { st.textContent = 'checking against your systems…'; st.style.color = 'var(--dim)'; }
  else if (t >= T.stream[0]) { st.textContent = 'writing…'; st.style.color = 'var(--dim)'; }
  else st.textContent = '';
}

function chip(el, t, a, b, ok, note) {
  show(el, fade(t, a, a + 0.35), 10);
  const s = el.querySelector('.st');
  if (t < b) s.innerHTML = `<span class="spin" style="transform:rotate(${t * 540}deg)"></span>`;
  else s.innerHTML = ok ? '<span style="color:var(--green)">✓</span>' : '<span style="color:var(--red)">✗</span>';
  if (note !== undefined) {
    const n = el.querySelector('.note');
    n.innerHTML = t < b ? '' : note;
  }
}

const PROMPT = 'When I label an email “Dealflow” in Gmail, add the company and founder to Attio, put it in VC Deal Flow at Sourcing, save the email as a note, and ping #dealflow.';
const REPLY = 'It’s live. From now on, every email you label Dealflow lands in Attio and #dealflow, with no agent in the loop.';

const RUN_CAPTION = D.run.modelCalls === 0
  ? 'Five writes in under a second. <em>No model calls, no tokens.</em>'
  : `${D.run.committed} writes and ${D.run.modelCalls === 1 ? 'one small model call' : D.run.modelCalls + ' model calls'}, for <em>${fmtCost(D.run.costUsd)}</em>.`;
const CAPTIONS = [
  [5.8, 9.9, 'Ask your agent for an automation, in plain words.'],
  [10.2, 13.5, 'It reads the <em>real schemas</em> of your connected systems…'],
  [13.8, 19.9, '…and writes a short program. Adapters handle auth, rate limits and pagination.'],
  [20.9, 27.3, 'Checked against your <em>live Attio</em> before it’s saved: “Sourcing” isn’t a stage there.'],
  [27.6, 31.4, 'One small edit, and it goes live.'],
  [31.6, 35.3, 'From now on it runs on every email, <em>without the agent</em>.'],
  [38.2, 42.4, 'A founder emails in. You label it Dealflow.'],
  [42.6, 47.3, RUN_CAPTION],
];

const WRITE_ROWS = (() => {
  const w = D.run.writes;
  const v = (i) => w[i].values;
  const rows = [];
  if (D.run.extract) rows.push(['Extract', D.run.extract.label, D.run.extract.target]);
  rows.push(
    ['Company', v(0).Name, w[0].target],
    ['Founder', v(1).Name, w[1].target],
    ['Stage', v(2).Stage, w[2].target],
    ['Note', v(3).Title.split(':')[0] + ': …', w[3].target],
    ['Message', '#dealflow', w[4].target],
  );
  return rows;
})();
const XO = D.run.extract ? 1 : 0; // write i's row index in WRITE_ROWS
const W0 = 39.2, WSTEP = 0.45, RUN_DONE = W0 + WSTEP * (WRITE_ROWS.length - 1) + 0.4;

function seek(t) {
  // title
  show($('t1'), win(t, 0.3, 1.0, 4.3, 4.9), 24);
  show($('t2'), win(t, 1.6, 2.3, 4.3, 4.9), 24);

  // authoring stage
  const so = win(t, T.stageIn, T.stageIn + 0.6, T.stageOut[0], T.stageOut[1]);
  show($('stage'), so, 0);
  if (so > 0) {
    const p = typed(PROMPT, t, T.prompt[0], T.prompt[1]);
    $('ubub').innerHTML = esc(p) + (t < T.prompt[1] + 0.3 ? CARET : '');
    show($('agent'), fade(t, T.agent, T.agent + 0.4), 12);
    chip($('c1'), t, T.c1[0], T.c1[1], true);
    chip($('c2'), t, T.c2[0], T.c2[1], true);
    show($('schema'), fade(t, T.c2[1], T.c2[1] + 0.4), 8);
    chip($('c3'), t, T.c3[0], T.c3[1], false, '<span style="color:var(--red)">Not saved · 1 error</span>');
    chip($('c4'), t, T.c4[0], T.c4[1], true, '<span style="color:var(--green)">Saved · live</span>');
    show($('abub'), fade(t, T.abub[0], T.abub[0] + 0.3), 10);
    $('abub').innerHTML = esc(typed(REPLY, t, T.abub[0], T.abub[1]));
    renderCode(t);
  }

  // "later"
  show($('later'), win(t, 36.0, 36.4, 37.2, 37.6), 0);

  // run stage
  const ro = win(t, 37.6, 38.0, 47.4, 48.0);
  show($('runstage'), ro, 0);
  if (ro > 0) {
    const e = D.run.email;
    const m = e.from.match(/^(.*?)\s*<(.+)>$/);
    $('efrom').textContent = m[1]; $('eaddr').textContent = m[2];
    $('esubj').textContent = e.subject; $('ebody').textContent = e.body;
    show($('email'), fade(t, 37.8, 38.4), 0, -40);
    show($('runbox'), fade(t, 38.6, 39.0), 14);
    let rows = '';
    WRITE_ROWS.forEach(([k, val, tgt], i) => {
      const o = fade(t, W0 + i * WSTEP, W0 + i * WSTEP + 0.25);
      rows += `<div class="w" style="opacity:${o}"><span class="ok">✓</span><span>${esc(k)} <b>${esc(val)}</b></span><span class="tgt">${esc(tgt)}</span></div>`;
    });
    $('writes').innerHTML = rows;
    const done = t >= RUN_DONE;
    $('rspin').style.display = done ? 'none' : 'inline-block';
    $('rspin').style.transform = `rotate(${t * 540}deg)`;
    $('rtitle').innerHTML = done ? '<span style="color:var(--green)">✓</span>&nbsp; Founder Intake · ' + esc(D.run.status) : 'Founder Intake · running';
    const so2 = fade(t, RUN_DONE + 0.1, RUN_DONE + 0.5);
    $('stats').style.opacity = so2;
    $('stats').innerHTML = [
      [(D.run.ms / 1000).toFixed(2) + ' s', 'run time'], [String(D.run.committed), 'writes'],
      [String(D.run.modelCalls), 'model calls'], [fmtCost(D.run.costUsd), 'cost'],
    ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');

    const at = (i) => fade(t, W0 + (i + XO) * WSTEP, W0 + (i + XO) * WSTEP + 0.3);
    show($('r1'), at(0), 0, 40);
    const w = D.run.writes;
    $('r1kv').innerHTML =
      `<span style="opacity:${at(0)}">Name</span><span style="opacity:${at(0)}">${esc(w[0].values.Name)}</span>` +
      `<span style="opacity:${at(0)}">Domains</span><span style="opacity:${at(0)}">${esc(w[0].values.Domains)}</span>` +
      (w[0].values.Description ? `<span style="opacity:${at(0)}">Description</span><span style="opacity:${at(0)}">${esc(w[0].values.Description)}</span>` : '') +
      `<span style="opacity:${at(1)}">Team</span><span style="opacity:${at(1)}">${esc(w[1].values.Name)} · ${esc(w[1].values.Email)}</span>` +
      `<span style="opacity:${at(2)}">VC Deal Flow</span><span style="opacity:${at(2)}"><span class="pill" style="background:rgba(74,222,128,.15);color:var(--green)">${esc(w[2].values.Stage)}</span></span>`;
    show($('r2'), at(3), 0, 40);
    $('r2kv').innerHTML = `<span>Title</span><span>${esc(w[3].values.Title)}</span><span>Content</span><span>the full email body</span>`;
    show($('r3'), at(4), 0, 40);
    $('r3tx').textContent = w[4].values.Message;
  }

  // closing
  const co = win(t, 48.2, 48.8, 55.6, 56.2);
  show($('closing'), co, 0);
  show($('k1'), fade(t, 49.0, 49.5) * co, 20);
  show($('k2'), fade(t, 49.5, 50.0) * co, 20);
  show($('k3'), fade(t, 50.0, 50.5) * co, 20);
  show($('stat'), fade(t, 51.2, 51.7) * co, 14);
  show($('endmark'), fade(t, 56.4, 57.1), 20);

  // chrome
  show($('footer'), win(t, 5.2, 5.8, 47.4, 48.0), 0);
  const cap = CAPTIONS.find(([a, b]) => t >= a - 0.01 && t <= b);
  const capEl = $('caption');
  if (cap) { capEl.innerHTML = cap[2]; show(capEl, win(t, cap[0], cap[0] + 0.3, cap[1] - 0.3, cap[1]), 10); }
  else show(capEl, 0, 0);
}
window.seek = seek;
seek(0);
