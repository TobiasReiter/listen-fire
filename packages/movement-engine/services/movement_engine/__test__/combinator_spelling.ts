// Language version 5 spells the combinators `race(f, g)` / `all(f, g)`: the
// arms are the call's arguments (a closure is not data, so there is no list
// of them), there is no `await`, and `parallel` is `all`. A both-engine case
// written once for every version runs under 5 as this rewrites it.

const WRITTEN_ARMS = /await (race|parallel)\(\s*\[/g;

/** `source` with every `await race([…])` / `await parallel([…])` whose arms
 *  are written down spelled as version 5 spells it. Arms built at run time
 *  (`await race(arms)`) are left as written: version 5 has no such form. */
export function spelledForVersion5(source: string): string {
  let out = '';
  let from = 0;
  for (const match of source.matchAll(WRITTEN_ARMS)) {
    const open = match.index + match[0].length - 1;
    const close = matchingBracket(source, open);
    if (close === undefined || source[close + 1] !== ')') continue;
    out += source.slice(from, match.index) + (match[1] === 'race' ? 'race(' : 'all(') + source.slice(open + 1, close);
    from = close + 1;
  }
  return out + source.slice(from);
}

function matchingBracket(source: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      for (i++; i < source.length && source[i] !== '"'; i++) if (source[i] === '\\') i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return c === ']' ? i : undefined;
    }
  }
  return undefined;
}
