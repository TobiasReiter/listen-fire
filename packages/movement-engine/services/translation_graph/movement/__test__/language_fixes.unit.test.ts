// Language fixes from the 2026-07-10 authoring friction report:
//  1. Nested value-level IF with an explicit inner END (two ENDs) must parse
//     — the ELSE-IF chain (one END) must keep working too.
//  2. A value-level IF may span multiple lines.
//  3. An #extract field's description string may sit on the line after its
//     <type> annotation.
import { parseProgram, parseMovementExpression, type Program, type Statement } from 'movement-lang';

/** Every write-field ExprSlot.raw in the program, by field name. */
function writeFieldSlots(program: Program): Record<string, string> {
  const out: Record<string, string> = {};
  const walkStatements = (statements: Statement[]): void => {
    for (const s of statements) {
      if (s.kind === 'write') collectWrite(s.write);
      else if (s.kind === 'movement') walkStatements(s.body);
      else if (s.kind === 'block') walkStatements(s.block.body);
      else if (s.kind === 'assign' && s.value.kind === 'block') walkStatements(s.value.block.body);
      else if (s.kind === 'assign' && s.value.kind === 'write') collectWrite(s.value.write);
    }
  };
  const collectWrite = (write: { fields: Array<{ name: string; value: { raw: string } }> }): void => {
    for (const f of write.fields) out[f.name] = f.value.raw;
  };
  walkStatements(program.statements);
  return out;
}

describe('nested value-level IF', () => {
  it('parses the ELSE-IF chain (single END)', () => {
    const expr = parseMovementExpression('IF a THEN "x" ELSE IF b THEN "y" ELSE "z" END');
    expect(expr.type).toBe('conditional');
  });

  it('parses explicit nesting with an inner END (two ENDs)', () => {
    const expr = parseMovementExpression('IF a THEN "x" ELSE IF b THEN "y" ELSE "z" END END');
    expect(expr.type).toBe('conditional');
  });

  it('parses three-level explicit nesting (three ENDs)', () => {
    const expr = parseMovementExpression(
      'IF a THEN "x" ELSE IF b THEN "y" ELSE IF c THEN "z" ELSE "w" END END END',
    );
    expect(expr.type).toBe('conditional');
  });
});

describe('multi-line value-level IF', () => {
  const src = `import { manual, attio } from adapters
import { \`Attio (Test)\` } from credentials

runs = manual()
crm  = attio(credentials: \`Attio (Test)\`)

movement m(go: <runs-[:Invocation]->>) {
  write crm-[:Companies]-> {
    Name: c.name
    Description: IF c.website
      THEN "has a site"
      ELSE "no site"
    END
  }
}

listen to runs {} fire m`;

  it('captures the whole IF across lines and it parses to a conditional', () => {
    const slots = writeFieldSlots(parseProgram(src));
    expect(slots.Description).toContain('ELSE');
    expect(parseMovementExpression(slots.Description).type).toBe('conditional');
  });
});

describe('#extract description on the next line', () => {
  const wrap = (body: string) => `import { manual } from adapters

runs = manual()

movement m(go: <runs-[:Invocation]->>) {
  found = extract from [go.\`Text\`] {
${body}
  }
}

listen to runs {} fire m`;

  it('allows a newline between a <type> annotation and its description', () => {
    const src = wrap(`    node company: "each company" {
      amount: <number>
        "the amount raised"
    }`);
    expect(() => parseProgram(src)).not.toThrow();
  });

  it('allows a newline before a node description', () => {
    const src = wrap(`    node company:
      "each company" {
      name: "the company name"
    }`);
    expect(() => parseProgram(src)).not.toThrow();
  });
});
