// A small markdown renderer for exactly the subset this repo's docs use:
// headings, fenced code, tables, nested lists, blockquotes, paragraphs, and
// inline code, links, bold and italic. No dependency, so the docs build needs
// nothing installed.

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*~]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** `resolveLink(href)` returns the href to emit for a link in the source. */
function inline(text, resolveLink) {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let s = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => keep(`<code>${escapeHtml(code.trim())}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) =>
    keep(`<a href="${escapeHtml(resolveLink(href))}">${inline(label, resolveLink)}</a>`),
  );
  s = escapeHtml(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?![\w*])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_([^_\s][^_]*)_(?![\w])/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

/** Returns { html, headings: [{ level, text, id }] }. */
export function renderMarkdown(source, { resolveLink = (h) => h } = {}) {
  const lines = source.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const headings = [];
  const seen = new Map();
  const out = [];
  const uniqueId = (text) => {
    const base = slugify(text) || 'section';
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
  const inl = (t) => inline(t, resolveLink);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    const fence = line.match(/^(\s*)(`{3,}|~{3,})\s*([\w-]*)/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[2])) {
        const indent = lines[i].length - lines[i].trimStart().length;
        body.push(lines[i].slice(Math.min(fence[1].length, indent)));
        i++;
      }
      i++;
      const lang = fence[3] ? ` class="language-${escapeHtml(fence[3])}"` : '';
      out.push(`<pre><code${lang}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const id = uniqueId(heading[2]);
      headings.push({ level, text: heading[2].replace(/[`*]/g, ''), id });
      out.push(`<h${level} id="${id}">${inl(heading[2])} <a class="anchor" href="#${id}" aria-label="link to this section">#</a></h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (line.trimStart().startsWith('>')) {
      const quote = [];
      while (i < lines.length && lines[i].trimStart().startsWith('>')) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(quote.join('\n'), { resolveLink }).html}</blockquote>`);
      continue;
    }

    if (line.trimStart().startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|')) rows.push(cells(lines[i++]));
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inl(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inl(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const block = [];
      while (i < lines.length && (LIST_ITEM.test(lines[i]) || (lines[i].trim() !== '' && /^\s+/.test(lines[i])) || (lines[i].trim() === '' && i + 1 < lines.length && (LIST_ITEM.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1]))))) block.push(lines[i++]);
      out.push(renderList(block, inl, resolveLink));
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|\s*(`{3,}|~{3,})|\s*>|\s*\|)/.test(lines[i]) && !LIST_ITEM.test(lines[i])) para.push(lines[i++].trim());
    if (para.length === 0) { para.push(lines[i++].trim()); }
    out.push(`<p>${inl(para.join(' '))}</p>`);
  }
  return { html: out.join('\n'), headings };
}

function renderList(lines, inl, resolveLink) {
  const first = lines[0].match(LIST_ITEM);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  for (const line of lines) {
    const m = line.match(LIST_ITEM);
    if (m && m[1].length <= base && (!items.length || m[1].length === base)) items.push([m[3]]);
    else if (items.length) items[items.length - 1].push(line);
  }
  const body = items.map((item) => {
    const [head, ...rest] = item;
    const restLines = rest.filter((l) => l.trim() !== '' || true);
    const nestedStart = restLines.findIndex((l) => LIST_ITEM.test(l));
    const cont = (nestedStart === -1 ? restLines : restLines.slice(0, nestedStart)).map((l) => l.trim()).filter(Boolean);
    const nested = nestedStart === -1 ? '' : renderList(restLines.slice(nestedStart).filter((l) => l.trim() !== ''), inl, resolveLink);
    return `<li>${inl([head, ...cont].join(' '))}${nested}</li>`;
  });
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}>${body.join('')}</${tag}>`;
}
