// Link checker over the built site: every internal href and #fragment must resolve.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'site');
const files = [];
const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.html') && files.push(join(d, f))));
walk(site);

const idsOf = new Map();
const ids = (file) => {
  if (!idsOf.has(file)) idsOf.set(file, new Set([...readFileSync(file, 'utf8').matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])));
  return idsOf.get(file);
};

const broken = [];
for (const file of files) {
  const html = readFileSync(file, 'utf8');
  for (const [, href] of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href === '') continue;
    const [path, hash] = href.replaceAll('&amp;', '&').split('#');
    const target = path ? resolve(dirname(file), path) : file;
    if (!existsSync(target)) broken.push(`${file}: missing file ${href}`);
    else if (hash && target.endsWith('.html') && !ids(target).has(hash)) broken.push(`${file}: missing anchor ${href}`);
  }
}
if (broken.length) {
  console.error(broken.join('\n'));
  process.exit(1);
}
console.log(`docs: ${files.length} pages, no broken internal links`);
