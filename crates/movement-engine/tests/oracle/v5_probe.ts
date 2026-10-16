// Investigation probe: every admission pattern's programs, and a few written
// for language version 5, run under version 5 on both engines.
process.env.TZ = 'UTC';
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL_TEST ??= 'postgresql://oracle:oracle@localhost:5432/oracle-unused';
process.env.DATABASE_URL_TEST_READONLY ??= 'postgresql://oracle:oracle@localhost:5432/oracle-unused';
process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.SCRAPER_API_KEY ??= 'oracle-unused';

import { writeFileSync } from 'node:fs';
import { probeVersion } from './patterns_oracle';
import type { Program } from './patterns_table';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const b = (reason: string, body: string): { reason: string; program: Program } => ({ reason: `v5:${reason}`, program: { body } });
const f = (reason: string, file: string, movementName = 'm'): { reason: string; program: Program } => ({ reason: `v5:${reason}`, program: { file, movementName, replies: REPLIES } });
const said = (value: unknown) => ({ evidence: String(value), value });
const REPLIES = [1, 2, 3, 4].map(() => ({ 'x:extract_result#1': [{ name: said('Acme') }], 'x:extract_result#2': [{ name: said('Acme') }] }));

const EXTRA = [
  // name_not_value: a bare name in a through-stage plugin argument holding other than a value
  f('name_not_value', 'import { echo } from plugins\nmovement m(msg: <inbox-[:message]->>) {\n  co = write crm-[:companies]-> { name: "Acme" }\n  d = extract from [msg.`text`] through [echo(q: co)] {\n    name: "a name"\n  }\n}'),
  f('name_not_value', 'import { echo } from plugins\nmovement m(msg: <inbox-[:message]->>) {\n  crm-[c:companies]-> {\n    d = extract from [msg.`text`] through [echo(q: c)] {\n      name: "a name"\n    }\n  }\n}'),
  f('name_not_value', 'import { echo } from plugins\nmovement m(msg: <inbox-[:message]->>) {\n  e = extract from [msg.`text`] {\n    name: "a name"\n  }\n  d = extract from [msg.`text`] through [echo(q: e)] {\n    name: "a name"\n  }\n}'),
  f('name_not_value', 'import { echo } from plugins\nmovement m(msg: <inbox-[:message]->>) {\n  n = node { title: "t" }\n  d = extract from [msg.`text`] through [echo(q: n)] {\n    name: "a name"\n  }\n}'),
  f('name_not_value', 'import { echo } from plugins\nmovement m(msg: <inbox-[:message]->>) {\n  k = () => 1\n  d = extract from [msg.`text`] through [echo(q: k)] {\n    name: "a name"\n  }\n}'),
  f('name_not_value', 'import { echo } from plugins\nmovement m(msg: <inbox-[:message]->>) {\n  co = ONLY(crm-[:companies]-> WHERE `name` = "Acme")\n  d = extract from [msg.`text`] through [echo(q: co)] {\n    name: "a name"\n  }\n}'),
  f('name_not_value', 'import { echo } from plugins\nmovement m(msg: <inbox-[:message]->>) {\n  rows = crm-[:companies]->\n  d = extract from [msg.`text`] through [echo(q: rows)] {\n    name: "a name"\n  }\n}'),
  // write_bind
  b('write_bind', '  write crm-[:companies]-> bind msg { name: "Acme" }'),
  // node_event_entry
  b('node_event_entry', '  g = graph { owner: msg }'),
  b('node_event_entry', '  g = node { owner: msg }'),
  b('node_event_entry', '  g = graph { title: "t", source: msg }\n  write crm-[:notes]-> { body: "x" }'),
  // traversal_meta_edge
  b('traversal_meta_edge', '  crm-[b:bags]-> {\n    x = FIRST(b-[:#foo]->)\n  }'),
  b('traversal_meta_edge', '  crm-[b:bags]-> {\n    write b-[:#foo]-> { body: "x" }\n  }'),
  b('traversal_meta_edge', '  x = COUNT(msg-[:#seen]->)'),
  // aggregate:sort_key
  b('aggregate:sort_key', '  rows = crm-[c:companies]->\n  x = SORT(rows, LOWER(`name`))\n  write crm-[:notes]-> { body: "${COUNT(x)}" }'),
  b('aggregate:sort_key', '  rows = crm-[c:companies]->\n  x = SORT(rows, `employees` * -1)\n  write crm-[:notes]-> { body: "${COUNT(x)}" }'),
  b('aggregate:sort_key', '  x = SORT(crm-[c:companies]->, LENGTH(c.`name`))\n  write crm-[:notes]-> { body: "${COUNT(x)}" }'),
  // within_compare
  b('within_compare', '  if "2025-12-30" WITHIN "7d" {\n    write crm-[:notes]-> { body: "recent" }\n  }'),
  b('within_compare', '  x = msg.`subject` WITHIN "7d"'),
  b('within_compare', '  crm-[c:companies WHERE `name` WITHIN "7d"]-> {\n    x = 1\n  }'),
  // call_arg_record, the collection-op (MAP/FILTER/REDUCE) path
  b('call_arg_record_multi', '  co = write crm-[:companies]-> { name: "Acme" }\n  note = (t: <text>) => {\n    write crm-[:notes]-> { body: t }\n  }\n  MAP([co], note)'),
  b('call_arg_record_multi', '  note = (t: <text>) => {\n    write crm-[:notes]-> { body: t }\n  }\n  MAP(crm-[:companies]->, note)'),
  b('call_arg_record_multi', '  co = write crm-[:companies]-> { name: "Acme" }\n  note = (t: <text>) => {\n    write crm-[:notes]-> { body: t }\n  }\n  MAP([COALESCE(co, "x")], note)'),
  b('call_arg_record_multi', '  co = write crm-[:companies]-> { name: "Acme" }\n  add = (acc: <text>, t: <text>) => acc\n  r = REDUCE(["a"], co, add)\n  write crm-[:notes]-> { body: "${r}" }'),
  b('call_arg_record_multi', '  co = write crm-[:companies]-> { name: "Acme" }\n  add = (acc: <text>, t: <text>) => CONCAT(acc, t)\n  r = REDUCE(["a"], COALESCE(co, "x"), add)\n  write crm-[:notes]-> { body: r }'),
  b('call_arg_record_multi', '  up = (t: <text>) => UPPER(t)\n  r = MAP(crm-[:companies]->, up)\n  write crm-[:notes]-> { body: "${COUNT(r)}" }'),
  b('call_arg_record_multi', '  co = write crm-[:companies]-> { name: "Acme" }\n  up = (t: <text>) => UPPER(t)\n  r = MAP([COALESCE(co, "x")], up)\n  write crm-[:notes]-> { body: "${COUNT(r)}" }'),
  b('call_arg_record_multi', '  rows = crm-[:companies]->\n  up = (t: <text>) => UPPER(t)\n  r = MAP(rows, up)\n  write crm-[:notes]-> { body: "${COUNT(r)}" }'),
  b('call_arg_record_multi', '  up = (t: <text>) => LENGTH(t) > 0\n  r = FILTER(crm-[:companies]->, up)\n  write crm-[:notes]-> { body: "${COUNT(r)}" }'),
  b('call_arg_record_multi', '  co = write crm-[:companies]-> { name: "Acme" }\n  keep = (t: <text>) => true\n  r = FILTER([COALESCE(co, "x")], keep)'),
  f('call_arg_record_multi', 'movement put(t: <text>) {\n  write crm-[:notes]-> { body: t }\n}\nmovement m(msg: <inbox-[:message]->>) {\n  co = write crm-[:companies]-> { name: "Acme" }\n  MAP([COALESCE(co, "x")], put)\n}'),
  b('x_multi', '  up = (t: <text>) => UPPER(t)\n  r = MAP(crm-[:companies]->, up)\n  write crm-[:notes]-> { body: "${r}" }'),
  b('x_multi', '  up = (t: <text>) => UPPER(t)\n  r = MAP([1, 2], up)\n  write crm-[:notes]-> { body: "${r}" }'),
  b('x_multi', '  up = (t: <number>) => t + 1\n  r = MAP(["a"], up)\n  write crm-[:notes]-> { body: "${r}" }'),
  b('x_multi', '  nm = (c) => c.`name`\n  r = MAP(crm-[:companies]->, nm)\n  write crm-[:notes]-> { body: "${r}" }'),
  b('x_multi', '  r = MAP(crm-[:companies]->, (c) => c.`name`)\n  write crm-[:notes]-> { body: "${r}" }'),
  // A function's call that hands back a node, written positionally from version 5.
  f('movement_call', 'node Note {\n  title: <text>\n}\nmovement make(t: <text>) {\n  return node { title: t }\n}\nmovement m(msg: <inbox-[:message]->>) {\n  l = msg.`subject`\n  n = make(t: l)\n  write crm-[:notes]-> { body: n.`title` }\n}'),
  f('movement_call', 'movement pick(n: <text>) {\n  co = write crm-[:companies]-> { name: n }\n  return co\n}\nmovement say(n: <text>) {\n  write crm-[:notes]-> { body: n }\n}\nmovement m(msg: <inbox-[:message]->>) {\n  co = pick(n: "Acme")\n  say(n: co.`name`)\n}'),
  { reason: 'v5:movement_call', program: { file: 'import { keep } from "lib/keep"\nmovement m(msg: <inbox-[:message]->>) {\n  k = keep(e: msg)\n  write crm-[:notes]-> { body: "${COUNT(k-[:files]->)}" }\n}', files: { 'lib/keep': { source: 'import { email } from adapters\nimport { inbox_cred } from credentials\ninbox = email(credentials: inbox_cred)\nexport function keep(e: <inbox-[:message]->>) {\n  n = node { files: lazy e-[a:files]-> }\n  await sleep(1h)\n  return n\n}' } }, movementName: 'm' } },
  b('x_multi', '  up = (t: <text>) => UPPER(t)\n  r = up(ONLY(crm-[:companies]->))\n  write crm-[:notes]-> { body: "${r}" }'),
];

void (async () => {
  const rows = await probeVersion(Number(process.env.PROBE_VERSION ?? 5), mulberry32(20261015), process.env.PROBE_EXTRA_ONLY ? EXTRA : EXTRA);
  writeFileSync(process.env.PROBE_OUT ?? 'v5_probe_out.json', `[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`);
  console.log(`rows: ${rows.length}`);
  process.exit(0);
})().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
