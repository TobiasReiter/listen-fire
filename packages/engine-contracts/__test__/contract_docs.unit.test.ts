// The contract docs' shape blocks against the code they transcribe. Syntax
// only: each `interface` in a doc's ```ts blocks is matched by name to the
// interface the code declares, and their members' names and optional marks
// must be equal. Member types are not compared — the doc may spell one more
// plainly (an inlined union for a named alias) — but a member the doc omits,
// adds, or marks differently fails here.
import fs from 'fs';
import path from 'path';

import ts from 'typescript';

const REPO = path.resolve(__dirname, '../../..');

const SOURCES = [
  'packages/movement-lang/checker/catalog.ts',
  'packages/movement-lang/service/snapshot.ts',
  'packages/shared/expression/types.ts',
  'packages/engine-contracts/park_state.ts',
];

type Members = Record<string, 'required' | 'optional'>;

function interfacesIn(text: string, file: string): Map<string, Members> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found = new Map<string, Members>();
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node)) {
      const members: Members = {};
      for (const member of node.members) {
        if (member.name === undefined) continue;
        const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : member.name.getText(source);
        members[name] = member.questionToken !== undefined ? 'optional' : 'required';
      }
      found.set(node.name.text, members);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const declared = new Map<string, Members>();
for (const file of SOURCES) {
  for (const [name, members] of interfacesIn(fs.readFileSync(path.join(REPO, file), 'utf8'), file)) {
    declared.set(name, members);
  }
}

function shapeBlocks(doc: string): string {
  const text = fs.readFileSync(path.join(REPO, 'docs/contracts', doc), 'utf8');
  return [...text.matchAll(/^```ts\n([\s\S]*?)^```/gm)].map((match) => match[1]).join('\n');
}

/** The names a doc's blocks declare (interfaces and type aliases), and the
 *  names their members' types refer to. */
function namesIn(text: string): { declares: Set<string>; refers: Set<string> } {
  const source = ts.createSourceFile('doc.ts', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const declares = new Set<string>();
  const refers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) declares.add(node.name.text);
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) refers.add(node.typeName.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { declares, refers };
}

const BUILT_IN = new Set(['Array', 'Record', 'Omit']);

/** Types a doc points to in prose rather than inlining. */
const POINTED_TO: Record<string, string[]> = {
  'catalog-snapshot.md': [],
  'park-state.md': ['BindingDescriptor', 'CollectionOpExpression', 'ClosureExpression', 'Span'],
};

describe.each(['catalog-snapshot.md', 'park-state.md'])('%s', (doc) => {
  const interfaces = [...interfacesIn(shapeBlocks(doc), doc)];

  it('inlines every type its shapes refer to, but those it points to in prose', () => {
    const { declares, refers } = namesIn(shapeBlocks(doc));
    const missing = [...refers].filter((name) => !declares.has(name) && !BUILT_IN.has(name));
    expect(missing.sort()).toEqual([...(POINTED_TO[doc] ?? [])].sort());
  });

  it('documents at least one interface', () => {
    expect(interfaces.length).toBeGreaterThan(0);
  });

  it.each(interfaces)('documents %s member for member as the code declares it', (name, members) => {
    expect({ name, members }).toEqual({ name, members: declared.get(name) });
  });
});
