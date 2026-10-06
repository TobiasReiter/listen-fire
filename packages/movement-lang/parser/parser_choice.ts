// Which grammar the parser entry points run while both exist. Transition
// only: the TypeScript grammars and this switch are deleted once the Rust
// parser is the only parser (PLAN-02B Task 8).

declare const process: { env?: Record<string, string | undefined> } | undefined;

type ParserChoice = 'rust' | 'ts';

function readChoice(): ParserChoice {
  const value = typeof process === 'undefined' ? undefined : process.env?.MOVEMENT_PARSER;
  if (value === undefined || value === '' || value === 'rust') return 'rust';
  if (value === 'ts') return 'ts';
  // A typo silently running the other parser would hide which one a test ran.
  throw new Error(`MOVEMENT_PARSER must be 'rust' or 'ts', not '${value}'`);
}

/** Read once, when the parser loads. */
export const PARSER: ParserChoice = readChoice();
