// Records every expression text the current code produces while a test corpus
// runs, for the lowering regression (../__test__/lowering_regression.unit.test.ts).
//
// Two sources, because they disagree about what an "expression slot" is:
//   - every ExprSlot in every program the statement parser returns, under the
//     language version that parse ran with (`slot`);
//   - every text actually handed to the expression bridge from outside it — the
//     checker, service and story build probe texts of their own (a path head
//     plus a sentinel property) that no ExprSlot carries — and every slot read
//     through it (`expression` / `condition`, by which bridge entry received it).
//
// Appends JSON lines to $HARVEST_OUT. Run through ./jest.harvest.cjs.
const fs = require('fs');
const path = require('path');

const OUT = process.env.HARVEST_OUT;
const PACKAGE = path.resolve(__dirname, '../../..');
const PARSE = path.join(PACKAGE, 'parser/parse.ts');
const BRIDGE = path.join(PACKAGE, 'expression/bridge.ts');
const LANGUAGE_VERSION = path.join(PACKAGE, 'language_version.ts');

const testFile = path.relative(PACKAGE, expect.getState().testPath || '');
const records = [];

/** The source text a statement-layer span covers (lines and columns are 1-based). */
function spanText(source, span) {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  const offset = (loc) => lineStarts[loc.line - 1] + loc.col - 1;
  return source.slice(offset(span.start), offset(span.end));
}

/**
 * Besides the slots: the source of every construct the new grammar reads as an
 * expression but the statement layer reads today — a closure, a node or graph
 * literal, a node declaration — so the new parser can be run over them.
 */
function constructOf(node, key) {
  if (key === 'closure' && node.params && node.body && node.span) return 'closure';
  if (key === 'node' && Array.isArray(node.entries) && node.span) return node.graph ? 'graph' : 'node';
  if (node.kind === 'shape' && node.root && node.span) return 'declaration';
  return undefined;
}

function walkSlots(node, ctx, where, seen) {
  if (node === null || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) walkSlots(item, ctx, where, seen);
    return;
  }
  if (typeof node.raw === 'string' && node.span && typeof node.span === 'object') {
    records.push({ raw: node.raw, entry: 'slot', version: ctx.version, where, file: testFile });
  }
  const construct = constructOf(node, where);
  if (construct !== undefined) {
    records.push({ raw: spanText(ctx.source, node.span), entry: construct, version: ctx.version, file: testFile });
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'span') continue;
    walkSlots(value, ctx, key, seen);
  }
}

jest.mock(PARSE, () => {
  const actual = jest.requireActual(PARSE);
  const parseProgram = (source, options) => {
    const program = actual.parseProgram(source, options);
    const version =
      (options && options.languageVersion) ?? require(LANGUAGE_VERSION).CURRENT_LANGUAGE_VERSION;
    try {
      walkSlots(program, { version, source }, 'program', new Set());
    } catch {
      // A harvest failure must never change what the corpus test sees.
    }
    return program;
  };
  return { ...actual, parseProgram };
});

jest.mock(BRIDGE, () => {
  const actual = jest.requireActual(BRIDGE);
  const version = () => require(LANGUAGE_VERSION).CURRENT_LANGUAGE_VERSION;
  return {
    ...actual,
    parseMovementExpression: (raw) => {
      records.push({ raw, entry: 'expression', version: version(), file: testFile });
      return actual.parseMovementExpression(raw);
    },
    parseMovementCondition: (raw) => {
      records.push({ raw, entry: 'condition', version: version(), file: testFile });
      return actual.parseMovementCondition(raw);
    },
    expressionOfSlot: (slot) => {
      records.push({ raw: slot.raw, entry: 'expression', version: version(), file: testFile });
      return actual.expressionOfSlot(slot);
    },
    conditionOfSlot: (slot) => {
      records.push({ raw: slot.raw, entry: 'condition', version: version(), file: testFile });
      return actual.conditionOfSlot(slot);
    },
  };
});

afterAll(() => {
  // The regressions replay the fixtures through the bridge; their calls are
  // the harvest's output, not corpus.
  if (testFile.startsWith(path.join('parser', 'expression'))) return;
  if (testFile.startsWith(path.join('parser', '__test__', 'programs_regression'))) return;
  if (!OUT || records.length === 0) return;
  fs.appendFileSync(OUT, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
});
