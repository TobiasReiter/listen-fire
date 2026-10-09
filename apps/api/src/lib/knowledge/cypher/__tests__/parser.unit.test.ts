import type {
  CypherQuery,
  MutationCypherQuery,
  SetClause,
  DeleteClause,
  RemoveClause,
  CreateClause,
  MergeClause,
  NodePattern,
  RelationshipPattern,
  Expression,
} from '../types';

import { parseCypher, parseAnyCypher, ParseError } from '../parser';
import { isMutation } from '../types';

// --- Helpers ---

function node(variable?: string, label?: string): NodePattern {
  return {
    kind: 'node',
    ...(variable ? { variable } : {}),
    ...(label ? { label } : {}),
  };
}

function rel(
  direction: 'outgoing' | 'incoming' | 'undirected',
  type?: string,
  variable?: string,
): RelationshipPattern {
  return {
    kind: 'relationship',
    ...(variable ? { variable } : {}),
    ...(type ? { type } : {}),
    direction,
  };
}

function prop(variable: string, property: string): Expression {
  return { kind: 'property_access', variable, property };
}

function lit(value: string | number | boolean | null): Expression {
  return { kind: 'literal', value };
}

// --- MATCH clause parsing ---

describe('parseCypher', () => {
  describe('MATCH patterns', () => {
    it('parses a single node', () => {
      const q = parseCypher('MATCH (c:Company) RETURN c.name');
      expect(q.match.patterns).toHaveLength(1);
      expect(q.match.patterns[0].elements).toEqual([node('c', 'Company')]);
    });

    it('parses a node without label', () => {
      const q = parseCypher('MATCH (c) RETURN c');
      expect(q.match.patterns[0].elements).toEqual([node('c')]);
    });

    it('parses a node without variable', () => {
      const q = parseCypher('MATCH (:Company) RETURN 1');
      const n = q.match.patterns[0].elements[0] as NodePattern;
      expect(n.label).toBe('Company');
      expect(n.variable).toBeUndefined();
    });

    it('parses an outgoing relationship', () => {
      const q = parseCypher(
        'MATCH (c:Company)-[:has_round]->(r:Round) RETURN c.name',
      );
      expect(q.match.patterns[0].elements).toEqual([
        node('c', 'Company'),
        rel('outgoing', 'has_round'),
        node('r', 'Round'),
      ]);
    });

    it('parses an incoming relationship', () => {
      const q = parseCypher(
        'MATCH (c:Company)<-[:invested_in]-(i:Investor) RETURN c.name',
      );
      expect(q.match.patterns[0].elements).toEqual([
        node('c', 'Company'),
        rel('incoming', 'invested_in'),
        node('i', 'Investor'),
      ]);
    });

    it('parses an undirected relationship', () => {
      const q = parseCypher(
        'MATCH (a:A)-[:related]-(b:B) RETURN a.name',
      );
      expect(q.match.patterns[0].elements[1]).toEqual(
        rel('undirected', 'related'),
      );
    });

    it('parses a relationship with variable', () => {
      const q = parseCypher(
        'MATCH (a:A)-[e:related]->(b:B) RETURN a.name',
      );
      expect(q.match.patterns[0].elements[1]).toEqual(
        rel('outgoing', 'related', 'e'),
      );
    });

    it('parses a bare relationship (no type)', () => {
      const q = parseCypher('MATCH (a:A)-->(b:B) RETURN a.name');
      expect(q.match.patterns[0].elements[1]).toEqual(rel('outgoing'));
    });

    it('parses chained relationships', () => {
      const q = parseCypher(
        'MATCH (a:A)-[:r1]->(b:B)-[:r2]->(c:C) RETURN a.name',
      );
      const els = q.match.patterns[0].elements;
      expect(els).toHaveLength(5);
      expect(els[0]).toEqual(node('a', 'A'));
      expect(els[1]).toEqual(rel('outgoing', 'r1'));
      expect(els[2]).toEqual(node('b', 'B'));
      expect(els[3]).toEqual(rel('outgoing', 'r2'));
      expect(els[4]).toEqual(node('c', 'C'));
    });

    it('parses comma-separated patterns', () => {
      const q = parseCypher('MATCH (a:A), (b:B) RETURN a.name');
      expect(q.match.patterns).toHaveLength(2);
      expect(q.match.patterns[0].elements).toEqual([node('a', 'A')]);
      expect(q.match.patterns[1].elements).toEqual([node('b', 'B')]);
    });

    it('parses backtick-quoted identifiers', () => {
      const q = parseCypher(
        'MATCH (c:`Funding Round`) RETURN c.`total amount`',
      );
      expect((q.match.patterns[0].elements[0] as NodePattern).label).toBe(
        'Funding Round',
      );
      const ret = q.return.items[0].expression;
      expect(ret).toEqual(prop('c', 'total amount'));
    });

    it('parses unquoted multi-word node labels', () => {
      const q = parseCypher('MATCH (r:Funding Round) RETURN r.amount');
      expect((q.match.patterns[0].elements[0] as NodePattern).label).toBe(
        'Funding Round',
      );
      expect((q.match.patterns[0].elements[0] as NodePattern).variable).toBe('r');
    });

    it('parses unquoted multi-word edge types', () => {
      const q = parseCypher(
        "MATCH (p:Person)-[:Member Of]->(o:Organisation) RETURN o.Name",
      );
      expect(
        (q.match.patterns[0].elements[1] as RelationshipPattern).type,
      ).toBe('Member Of');
    });

    it('trims surrounding whitespace inside backticked labels', () => {
      const q = parseCypher(
        'MATCH (p:` Person `)-[:` Member Of `]->(o:Organisation) RETURN o.Name',
      );
      expect((q.match.patterns[0].elements[0] as NodePattern).label).toBe(
        'Person',
      );
      expect(
        (q.match.patterns[0].elements[1] as RelationshipPattern).type,
      ).toBe('Member Of');
    });

    it('parses edge variable with multi-word type', () => {
      const q = parseCypher(
        'MATCH (a:A)-[e:Works At]->(b:B) RETURN a.name',
      );
      const r = q.match.patterns[0].elements[1] as RelationshipPattern;
      expect(r.variable).toBe('e');
      expect(r.type).toBe('Works At');
    });

    it('trims trailing spaces from multi-word labels', () => {
      const q = parseCypher('MATCH (r:Funding Round  ) RETURN r.amount');
      expect((q.match.patterns[0].elements[0] as NodePattern).label).toBe(
        'Funding Round',
      );
    });
  });

  describe('WHERE clause', () => {
    it('parses equality', () => {
      const q = parseCypher("MATCH (c:Company) WHERE c.name = 'Acme' RETURN c");
      expect(q.where).toEqual({
        kind: 'binary',
        operator: '=',
        left: prop('c', 'name'),
        right: lit('Acme'),
      });
    });

    it('parses inequality operators', () => {
      for (const op of ['<>', '<', '>', '<=', '>='] as const) {
        const q = parseCypher(
          `MATCH (r:R) WHERE r.amount ${op} 100 RETURN r`,
        );
        expect(q.where).toEqual({
          kind: 'binary',
          operator: op,
          left: prop('r', 'amount'),
          right: lit(100),
        });
      }
    });

    it('parses AND', () => {
      const q = parseCypher(
        "MATCH (c:C) WHERE c.a = 'x' AND c.b = 'y' RETURN c",
      );
      expect(q.where).toEqual({
        kind: 'binary',
        operator: 'AND',
        left: { kind: 'binary', operator: '=', left: prop('c', 'a'), right: lit('x') },
        right: { kind: 'binary', operator: '=', left: prop('c', 'b'), right: lit('y') },
      });
    });

    it('parses OR', () => {
      const q = parseCypher(
        "MATCH (c:C) WHERE c.a = 'x' OR c.b = 'y' RETURN c",
      );
      expect(q.where!.kind).toBe('binary');
      expect((q.where as any).operator).toBe('OR');
    });

    it('parses AND/OR precedence (AND binds tighter)', () => {
      const q = parseCypher(
        "MATCH (c:C) WHERE c.a = 1 OR c.b = 2 AND c.c = 3 RETURN c",
      );
      // Should parse as: c.a = 1 OR (c.b = 2 AND c.c = 3)
      const w = q.where as any;
      expect(w.operator).toBe('OR');
      expect(w.right.operator).toBe('AND');
    });

    it('parses NOT', () => {
      const q = parseCypher(
        "MATCH (c:C) WHERE NOT c.name = 'Bad' RETURN c",
      );
      expect(q.where).toEqual({
        kind: 'unary',
        operator: 'NOT',
        operand: {
          kind: 'binary',
          operator: '=',
          left: prop('c', 'name'),
          right: lit('Bad'),
        },
      });
    });

    it('parses IS NULL', () => {
      const q = parseCypher('MATCH (c:C) WHERE c.name IS NULL RETURN c');
      expect(q.where).toEqual({
        kind: 'is_null',
        operand: prop('c', 'name'),
        negated: false,
      });
    });

    it('parses IS NOT NULL', () => {
      const q = parseCypher('MATCH (c:C) WHERE c.name IS NOT NULL RETURN c');
      expect(q.where).toEqual({
        kind: 'is_null',
        operand: prop('c', 'name'),
        negated: true,
      });
    });

    it('parses CONTAINS', () => {
      const q = parseCypher(
        "MATCH (c:C) WHERE c.name CONTAINS 'tech' RETURN c",
      );
      expect(q.where).toEqual({
        kind: 'binary',
        operator: 'CONTAINS',
        left: prop('c', 'name'),
        right: lit('tech'),
      });
    });

    it('parses STARTS WITH', () => {
      const q = parseCypher(
        "MATCH (c:C) WHERE c.name STARTS WITH 'A' RETURN c",
      );
      expect(q.where).toEqual({
        kind: 'binary',
        operator: 'STARTS WITH',
        left: prop('c', 'name'),
        right: lit('A'),
      });
    });

    it('parses ENDS WITH', () => {
      const q = parseCypher(
        "MATCH (c:C) WHERE c.name ENDS WITH 'Inc' RETURN c",
      );
      expect(q.where).toEqual({
        kind: 'binary',
        operator: 'ENDS WITH',
        left: prop('c', 'name'),
        right: lit('Inc'),
      });
    });

    it('parses parenthesized expressions', () => {
      const q = parseCypher(
        "MATCH (c:C) WHERE (c.a = 1 OR c.b = 2) AND c.c = 3 RETURN c",
      );
      const w = q.where as any;
      expect(w.operator).toBe('AND');
      expect(w.left.operator).toBe('OR');
    });

    it('parses negative numbers', () => {
      const q = parseCypher('MATCH (r:R) WHERE r.amount > -100 RETURN r');
      expect((q.where as any).right).toEqual(lit(-100));
    });

    it('parses decimal numbers', () => {
      const q = parseCypher(
        'MATCH (r:R) WHERE r.amount >= 1000000.50 RETURN r',
      );
      expect((q.where as any).right).toEqual(lit(1000000.5));
    });

    it('parses boolean literals', () => {
      const q = parseCypher('MATCH (c:C) WHERE c.active = TRUE RETURN c');
      expect((q.where as any).right).toEqual(lit(true));
    });

    it('parses null literal', () => {
      const q = parseCypher('MATCH (c:C) WHERE c.name = NULL RETURN c');
      expect((q.where as any).right).toEqual(lit(null));
    });

    it('parses escaped strings', () => {
      const q = parseCypher(
        "MATCH (c:C) WHERE c.name = 'it\\'s' RETURN c",
      );
      expect((q.where as any).right).toEqual(lit("it's"));
    });
  });

  describe('RETURN clause', () => {
    it('parses property access', () => {
      const q = parseCypher('MATCH (c:C) RETURN c.name');
      expect(q.return.items).toHaveLength(1);
      expect(q.return.items[0].expression).toEqual(prop('c', 'name'));
    });

    it('parses variable ref', () => {
      const q = parseCypher('MATCH (c:C) RETURN c');
      expect(q.return.items[0].expression).toEqual({
        kind: 'variable',
        name: 'c',
      });
    });

    it('parses multiple items', () => {
      const q = parseCypher('MATCH (c:C) RETURN c.name, c.age, c.city');
      expect(q.return.items).toHaveLength(3);
    });

    it('parses aliases', () => {
      const q = parseCypher('MATCH (c:C) RETURN c.name AS company_name');
      expect(q.return.items[0].alias).toBe('company_name');
    });

    it('parses DISTINCT', () => {
      const q = parseCypher('MATCH (c:C) RETURN DISTINCT c.name');
      expect(q.return.distinct).toBe(true);
    });

    it('parses COUNT(*)', () => {
      const q = parseCypher('MATCH (c:C) RETURN COUNT(*) AS total');
      const expr = q.return.items[0].expression;
      expect(expr).toEqual({
        kind: 'function_call',
        name: 'COUNT',
        args: [],
      });
      expect(q.return.items[0].alias).toBe('total');
    });

    it('parses COUNT(DISTINCT x)', () => {
      const q = parseCypher('MATCH (c:C) RETURN COUNT(DISTINCT c.name) AS unique');
      const expr = q.return.items[0].expression;
      expect(expr).toEqual({
        kind: 'function_call',
        name: 'COUNT',
        args: [prop('c', 'name')],
        distinct: true,
      });
    });

    it('parses SUM, AVG, MIN, MAX', () => {
      for (const fn of ['SUM', 'AVG', 'MIN', 'MAX']) {
        const q = parseCypher(
          `MATCH (r:R) RETURN ${fn}(r.amount) AS val`,
        );
        const expr = q.return.items[0].expression;
        expect(expr).toEqual({
          kind: 'function_call',
          name: fn,
          args: [prop('r', 'amount')],
        });
      }
    });
  });

  describe('ORDER BY', () => {
    it('parses ascending (default)', () => {
      const q = parseCypher('MATCH (c:C) RETURN c.name ORDER BY c.name');
      expect(q.orderBy).toHaveLength(1);
      expect(q.orderBy![0].direction).toBe('ASC');
    });

    it('parses explicit ASC', () => {
      const q = parseCypher('MATCH (c:C) RETURN c.name ORDER BY c.name ASC');
      expect(q.orderBy![0].direction).toBe('ASC');
    });

    it('parses DESC', () => {
      const q = parseCypher(
        'MATCH (c:C) RETURN c.name ORDER BY c.name DESC',
      );
      expect(q.orderBy![0].direction).toBe('DESC');
    });

    it('parses multiple order items', () => {
      const q = parseCypher(
        'MATCH (c:C) RETURN c.name, c.age ORDER BY c.age DESC, c.name ASC',
      );
      expect(q.orderBy).toHaveLength(2);
      expect(q.orderBy![0].direction).toBe('DESC');
      expect(q.orderBy![1].direction).toBe('ASC');
    });
  });

  describe('LIMIT', () => {
    it('parses limit', () => {
      const q = parseCypher('MATCH (c:C) RETURN c.name LIMIT 10');
      expect(q.limit).toBe(10);
    });

    it('no limit returns undefined', () => {
      const q = parseCypher('MATCH (c:C) RETURN c.name');
      expect(q.limit).toBeUndefined();
    });
  });

  describe('case insensitivity', () => {
    it('handles lowercase keywords', () => {
      const q = parseCypher('match (c:C) where c.name = 1 return c.name order by c.name limit 5');
      expect(q.match.patterns).toHaveLength(1);
      expect(q.where).toBeDefined();
      expect(q.orderBy).toHaveLength(1);
      expect(q.limit).toBe(5);
    });

    it('handles mixed case keywords', () => {
      const q = parseCypher('Match (c:C) Where c.x = 1 Return c.x');
      expect(q.match.patterns).toHaveLength(1);
    });
  });

  describe('error handling', () => {
    it('rejects non-Cypher input', () => {
      expect(() => parseCypher('SELECT * FROM foo')).toThrow(ParseError);
    });

    it('rejects missing RETURN', () => {
      expect(() => parseCypher('MATCH (c:C)')).toThrow(ParseError);
    });

    it('rejects empty input', () => {
      expect(() => parseCypher('')).toThrow(ParseError);
    });

    it('rejects MATCH without pattern', () => {
      expect(() => parseCypher('MATCH RETURN c')).toThrow(ParseError);
    });
  });

  describe('HAVING', () => {
    it('parses HAVING with comparison on alias', () => {
      const q = parseCypher(
        'MATCH (p:Person)-[:Member Of]->(o:Organisation) ' +
          'RETURN o.Name AS org, COUNT(p) AS team_count ' +
          'HAVING team_count >= 2',
      );
      expect(q.having).toBeDefined();
      expect(q.having!.kind).toBe('binary');
      const h = q.having as any;
      expect(h.operator).toBe('>=');
      expect(h.left.kind).toBe('variable');
      expect(h.left.name).toBe('team_count');
      expect(h.right.value).toBe(2);
    });

    it('parses HAVING with AND', () => {
      const q = parseCypher(
        'MATCH (p:Person)-[:r]->(o:Org) ' +
          'RETURN o.Name AS org, COUNT(p) AS cnt, SUM(p.age) AS total_age ' +
          'HAVING cnt >= 2 AND total_age > 100',
      );
      expect(q.having!.kind).toBe('binary');
      expect((q.having as any).operator).toBe('AND');
    });

    it('parses HAVING before ORDER BY', () => {
      const q = parseCypher(
        'MATCH (p:Person)-[:r]->(o:Org) ' +
          'RETURN o.Name AS org, COUNT(p) AS cnt ' +
          'HAVING cnt >= 2 ' +
          'ORDER BY cnt DESC ' +
          'LIMIT 10',
      );
      expect(q.having).toBeDefined();
      expect(q.orderBy).toHaveLength(1);
      expect(q.limit).toBe(10);
    });

    it('works without HAVING', () => {
      const q = parseCypher('MATCH (c:C) RETURN c.name');
      expect(q.having).toBeUndefined();
    });
  });

  describe('WITH clause', () => {
    it('resolves WITH aliases in RETURN and converts WHERE to HAVING', () => {
      const q = parseCypher(
        'MATCH (p:Person)-[:Member Of]->(o:Organisation) ' +
          'WITH o, COUNT(p) AS team_count ' +
          'WHERE team_count >= 2 ' +
          'RETURN o.Name AS organisation_name, team_count ' +
          'ORDER BY team_count DESC',
      );
      // RETURN items use the actual RETURN clause with aliases resolved
      expect(q.return.items).toHaveLength(2);
      expect(q.return.items[0].alias).toBe('organisation_name');
      expect(q.return.items[0].expression).toEqual(prop('o', 'Name'));
      // team_count in RETURN resolves to COUNT(p) from WITH
      expect(q.return.items[1].expression.kind).toBe('function_call');
      expect((q.return.items[1].expression as any).name).toBe('COUNT');
      // WITH's WHERE becomes HAVING, with aliases resolved
      expect(q.having).toBeDefined();
      expect(q.having!.kind).toBe('binary');
      const h = q.having as any;
      expect(h.operator).toBe('>=');
      expect(h.left.kind).toBe('function_call'); // team_count → COUNT(p)
      expect(h.right.value).toBe(2);
      // ORDER BY team_count also resolves
      expect(q.orderBy).toHaveLength(1);
      expect(q.orderBy![0].expression.kind).toBe('function_call');
    });

    it('parses WITH without WHERE', () => {
      const q = parseCypher(
        'MATCH (p:Person)-[:r]->(o:Org) ' +
          'WITH o, COUNT(p) AS cnt ' +
          'RETURN o.Name, cnt',
      );
      expect(q.return.items).toHaveLength(2);
      // cnt resolves to COUNT(p)
      expect(q.return.items[1].expression.kind).toBe('function_call');
      expect(q.having).toBeUndefined();
    });

    it('propagates WITH DISTINCT to RETURN', () => {
      const q = parseCypher(
        'MATCH (p:Person)-[:r]->(o:Org) ' +
          'WITH DISTINCT o ' +
          'RETURN o.Name',
      );
      expect(q.return.distinct).toBe(true);
    });

    it('does not override RETURN DISTINCT with non-distinct WITH', () => {
      const q = parseCypher(
        'MATCH (p:Person)-[:r]->(o:Org) ' +
          'WITH o, COUNT(p) AS cnt ' +
          'RETURN DISTINCT o.Name, cnt',
      );
      expect(q.return.distinct).toBe(true);
    });

    it('parses WITH with LIMIT', () => {
      const q = parseCypher(
        'MATCH (p:Person)-[:r]->(o:Org) ' +
          'WITH o, COUNT(p) AS cnt WHERE cnt >= 3 ' +
          'RETURN o.Name, cnt LIMIT 10',
      );
      expect(q.having).toBeDefined();
      expect(q.limit).toBe(10);
    });
  });

  describe('IN expression', () => {
    it('parses IN with list literal', () => {
      const q = parseCypher("MATCH (c:Company) WHERE c.stage IN ['A', 'B'] RETURN c.name");
      expect(q.where!.kind).toBe('in');
      const inExpr = q.where as any;
      expect(inExpr.negated).toBe(false);
      expect(inExpr.operand.kind).toBe('property_access');
      expect(inExpr.list.kind).toBe('list');
      expect(inExpr.list.elements).toHaveLength(2);
    });

    it('parses NOT IN', () => {
      const q = parseCypher("MATCH (c:Company) WHERE c.stage NOT IN ['C'] RETURN c.name");
      expect(q.where!.kind).toBe('in');
      expect((q.where as any).negated).toBe(true);
    });
  });

  describe('SKIP clause', () => {
    it('parses SKIP', () => {
      const q = parseCypher('MATCH (c:Company) RETURN c.name SKIP 10 LIMIT 5');
      expect(q.skip).toBe(10);
      expect(q.limit).toBe(5);
    });

    it('parses SKIP without LIMIT', () => {
      const q = parseCypher('MATCH (c:Company) RETURN c.name SKIP 20');
      expect(q.skip).toBe(20);
      expect(q.limit).toBeUndefined();
    });

    it('parses SKIP with parameter ref', () => {
      const q = parseCypher('MATCH (c:Company) RETURN c.name SKIP $offset LIMIT 5');
      expect(q.skip).toEqual({ kind: 'parameter', name: 'offset' });
      expect(q.limit).toBe(5);
    });

    it('parses LIMIT with parameter ref', () => {
      const q = parseCypher('MATCH (c:Company) RETURN c.name LIMIT $limit');
      expect(q.limit).toEqual({ kind: 'parameter', name: 'limit' });
    });

    it('parses both SKIP and LIMIT as parameter refs', () => {
      const q = parseCypher('MATCH (c:Company) RETURN c.name SKIP $offset LIMIT $limit');
      expect(q.skip).toEqual({ kind: 'parameter', name: 'offset' });
      expect(q.limit).toEqual({ kind: 'parameter', name: 'limit' });
    });

    it('parses positional ($0, $1) parameter refs in WHERE', () => {
      const q = parseCypher('MATCH (c:Company) WHERE c.name = $0 AND c.year = $1 RETURN c.id');
      const where = q.where as { kind: 'binary'; left: { right: unknown }; right: { right: unknown } };
      expect(where.left.right).toEqual({ kind: 'parameter', name: '0' });
      expect(where.right.right).toEqual({ kind: 'parameter', name: '1' });
    });

    it('parses positional parameter refs in node properties', () => {
      const q = parseCypher('MATCH (c:Company {name: $0}) RETURN c.id');
      const node = q.match.patterns[0].elements[0] as {
        kind: 'node';
        properties: { key: string; value: unknown }[];
      };
      expect(node.properties[0].value).toEqual({ kind: 'parameter', name: '0' });
    });

    it('parses positional parameter refs in SKIP/LIMIT', () => {
      const q = parseCypher('MATCH (c:Company) RETURN c.name SKIP $0 LIMIT $1');
      expect(q.skip).toEqual({ kind: 'parameter', name: '0' });
      expect(q.limit).toEqual({ kind: 'parameter', name: '1' });
    });
  });

  describe('EOF enforcement', () => {
    it('rejects trailing unparseable text', () => {
      expect(() => parseCypher('MATCH (c:C) RETURN c.name GARBAGE')).toThrow();
    });
  });

  describe('OPTIONAL MATCH', () => {
    it('parses OPTIONAL MATCH', () => {
      const q = parseCypher(
        'MATCH (c:Company) OPTIONAL MATCH (c)-[:has_round]->(r:Round) RETURN c.name, r.amount',
      );
      expect(q.match.patterns).toHaveLength(1);
      expect(q.optionalMatch).toBeDefined();
      expect(q.optionalMatch!.patterns).toHaveLength(1);
      expect(q.optionalMatch!.patterns[0].elements).toHaveLength(3);
    });

    it('parses OPTIONAL MATCH with WHERE', () => {
      const q = parseCypher(
        "MATCH (c:Company) OPTIONAL MATCH (c)-[:r]->(x:X) WHERE c.name = 'A' RETURN c.name",
      );
      expect(q.optionalMatch).toBeDefined();
      expect(q.where).toBeDefined();
    });
  });

  describe('scalar functions', () => {
    it('parses TOLOWER', () => {
      const q = parseCypher("MATCH (c:Company) WHERE TOLOWER(c.name) = 'acme' RETURN c.name");
      const where = q.where as any;
      expect(where.left.kind).toBe('function_call');
      expect(where.left.name).toBe('TOLOWER');
    });

    it('parses SIZE', () => {
      const q = parseCypher('MATCH (c:Company) RETURN SIZE(c.name) AS len');
      expect(q.return.items[0].expression.kind).toBe('function_call');
      expect((q.return.items[0].expression as any).name).toBe('SIZE');
    });
  });

  describe('COLLECT', () => {
    it('parses COLLECT as aggregate', () => {
      const q = parseCypher(
        'MATCH (c:Company)-[:r]->(i:Investor) RETURN c.name, COLLECT(i.name) AS investors',
      );
      expect(q.return.items[1].expression.kind).toBe('function_call');
      expect((q.return.items[1].expression as any).name).toBe('COLLECT');
      expect(q.return.items[1].alias).toBe('investors');
    });

    it('parses COLLECT with DISTINCT', () => {
      const q = parseCypher(
        'MATCH (c:Company)-[:r]->(i:Investor) RETURN c.name, COLLECT(DISTINCT i.name) AS investors',
      );
      const collect = q.return.items[1].expression as any;
      expect(collect.distinct).toBe(true);
    });
  });

  describe('inline node property predicates', () => {
    it('parses {key: value} on a node', () => {
      const q = parseCypher("MATCH (c:Company {name: 'Acme'}) RETURN c.name");
      const n = q.match.patterns[0].elements[0] as NodePattern;
      expect(n.label).toBe('Company');
      expect(n.properties).toEqual([{ key: 'name', value: lit('Acme') }]);
    });

    it('parses multiple properties', () => {
      const q = parseCypher("MATCH (c:Company {name: 'Acme', active: TRUE}) RETURN c");
      const n = q.match.patterns[0].elements[0] as NodePattern;
      expect(n.properties).toHaveLength(2);
      expect(n.properties![0].key).toBe('name');
      expect(n.properties![1].key).toBe('active');
      expect(n.properties![1].value).toEqual(lit(true));
    });

    it('parses properties with backtick-quoted label', () => {
      const q = parseCypher("MATCH (vc:`VC Firm` {Name: 'Tiny VC'}) RETURN vc.Name");
      const n = q.match.patterns[0].elements[0] as NodePattern;
      expect(n.label).toBe('VC Firm');
      expect(n.properties).toEqual([{ key: 'Name', value: lit('Tiny VC') }]);
    });

    it('parses without properties (no regression)', () => {
      const q = parseCypher('MATCH (c:Company) RETURN c.name');
      const n = q.match.patterns[0].elements[0] as NodePattern;
      expect(n.properties).toBeUndefined();
    });
  });

  describe('multiple MATCH clauses', () => {
    it('merges multiple MATCH clauses into one', () => {
      const q = parseCypher(
        'MATCH (a:A)-[:r1]->(b:B) ' +
          'MATCH (b)-[:r2]->(c:C) ' +
          'RETURN a.name, c.name',
      );
      expect(q.match.patterns).toHaveLength(2);
      expect(q.match.patterns[0].elements).toHaveLength(3);
      expect(q.match.patterns[1].elements).toHaveLength(3);
    });

    it('handles three MATCH clauses', () => {
      const q = parseCypher(
        'MATCH (a:A) ' +
          'MATCH (b:B) ' +
          'MATCH (c:C) ' +
          'RETURN a, b, c',
      );
      expect(q.match.patterns).toHaveLength(3);
    });

    it('handles multiple MATCH with WHERE', () => {
      const q = parseCypher(
        'MATCH (a:A)-[:r1]->(b:B) ' +
          'MATCH (b)-[:r2]->(c:C) ' +
          "WHERE c.name = 'X' " +
          'RETURN a.name',
      );
      expect(q.match.patterns).toHaveLength(2);
      expect(q.where).toBeDefined();
    });
  });

  describe('multiplicative operators', () => {
    it('parses multiplication', () => {
      const q = parseCypher('MATCH (r:R) RETURN r.price * r.quantity AS total');
      const expr = q.return.items[0].expression as any;
      expect(expr.kind).toBe('binary');
      expect(expr.operator).toBe('*');
    });

    it('parses division', () => {
      const q = parseCypher('MATCH (r:R) RETURN r.total / r.count AS avg');
      const expr = q.return.items[0].expression as any;
      expect(expr.operator).toBe('/');
    });

    it('parses modulo', () => {
      const q = parseCypher('MATCH (r:R) WHERE r.id % 2 = 0 RETURN r');
      const where = q.where as any;
      expect(where.left.operator).toBe('%');
    });

    it('respects precedence: * before +', () => {
      const q = parseCypher('MATCH (r:R) RETURN r.a + r.b * r.c AS val');
      const expr = q.return.items[0].expression as any;
      // Should be: a + (b * c)
      expect(expr.operator).toBe('+');
      expect(expr.right.operator).toBe('*');
    });
  });

  describe('CASE expression', () => {
    it('parses simple CASE WHEN', () => {
      const q = parseCypher(
        "MATCH (c:Company) RETURN CASE WHEN c.revenue > 1000000 THEN 'large' ELSE 'small' END AS size",
      );
      const expr = q.return.items[0].expression as any;
      expect(expr.kind).toBe('case');
      expect(expr.whens).toHaveLength(1);
      expect(expr.whens[0].condition.operator).toBe('>');
      expect(expr.whens[0].result.value).toBe('large');
      expect(expr.elseResult.value).toBe('small');
    });

    it('parses multiple WHEN clauses', () => {
      const q = parseCypher(
        "MATCH (c:C) RETURN CASE WHEN c.x > 100 THEN 'high' WHEN c.x > 50 THEN 'medium' ELSE 'low' END AS level",
      );
      const expr = q.return.items[0].expression as any;
      expect(expr.whens).toHaveLength(2);
    });

    it('parses CASE without ELSE', () => {
      const q = parseCypher(
        "MATCH (c:C) RETURN CASE WHEN c.active = TRUE THEN 'yes' END AS status",
      );
      const expr = q.return.items[0].expression as any;
      expect(expr.kind).toBe('case');
      expect(expr.elseResult).toBeUndefined();
    });
  });

  describe('COALESCE', () => {
    it('parses COALESCE with two arguments', () => {
      const q = parseCypher(
        "MATCH (c:Company) RETURN COALESCE(c.name, 'Unknown') AS name",
      );
      const expr = q.return.items[0].expression as any;
      expect(expr.kind).toBe('function_call');
      expect(expr.name).toBe('COALESCE');
      expect(expr.args).toHaveLength(2);
    });

    it('parses COALESCE with three arguments', () => {
      const q = parseCypher(
        "MATCH (c:C) RETURN COALESCE(c.a, c.b, 'default') AS val",
      );
      const expr = q.return.items[0].expression as any;
      expect(expr.args).toHaveLength(3);
    });
  });

  // --- Proposed extensions (TDD: use `it.failing` until implemented) ---

  describe('EXISTS subquery', () => {
    it('parses EXISTS { MATCH ... } in WHERE clause', () => {
      const q = parseCypher(
        'MATCH (c:Company) ' +
          'WHERE EXISTS { MATCH (c)-[:has_funding_round]->(r:`Funding Round`) } ' +
          'RETURN c.name',
      );
      expect(q.where).toBeDefined();
      const w = q.where as any;
      expect(w.kind).toBe('exists_subquery');
      // The inner MATCH should be preserved as a sub-AST
      expect(w.match).toBeDefined();
      expect(w.match.patterns).toHaveLength(1);
      expect(w.match.patterns[0].elements).toHaveLength(3);
    });

    it('parses EXISTS subquery with nested WHERE', () => {
      const q = parseCypher(
        'MATCH (c:Company) ' +
          "WHERE EXISTS { MATCH (c)-[:has_funding_round]->(r:`Funding Round`) WHERE r.amount > 1000000 } " +
          'RETURN c.name',
      );
      const w = q.where as any;
      expect(w.kind).toBe('exists_subquery');
      expect(w.where).toBeDefined();
      expect(w.where.operator).toBe('>');
    });

    it('parses EXISTS combined with other WHERE predicates via AND', () => {
      const q = parseCypher(
        "MATCH (c:Company) " +
          "WHERE c.name CONTAINS 'tech' AND EXISTS { MATCH (c)-[:has_funding_round]->(r:`Funding Round`) } " +
          'RETURN c.name',
      );
      const w = q.where as any;
      expect(w.operator).toBe('AND');
      expect(w.right.kind).toBe('exists_subquery');
    });
  });

  describe('id() function', () => {
    it('parses id(n) as a function call', () => {
      const q = parseCypher('MATCH (c:Company) RETURN id(c) AS cid');
      const expr = q.return.items[0].expression as any;
      expect(expr.kind).toBe('function_call');
      expect(expr.name).toBe('ID');
      expect(expr.args).toHaveLength(1);
      expect(expr.args[0]).toEqual({ kind: 'variable', name: 'c' });
    });

    it('parses WHERE id(n) = $param', () => {
      const q = parseCypher('MATCH (c:Company) WHERE id(c) = $id RETURN c.name');
      const w = q.where as any;
      expect(w.operator).toBe('=');
      expect(w.right).toEqual({ kind: 'parameter', name: 'id' });
      expect(w.left.kind).toBe('function_call');
      expect(w.left.name).toBe('ID');
    });
  });

  describe('n._id pseudo-property (parser supports; transpiler mapping TBD)', () => {
    // The parser already accepts `_id` as a valid identifier for property access.
    // The transpiler test in transpiler.unit.test.ts covers the semantic mapping
    // from n._id → the `id` column.
    it('parses n._id as a property access', () => {
      const q = parseCypher('MATCH (c:Company) RETURN c._id AS cid');
      expect(q.return.items[0].expression).toEqual(prop('c', '_id'));
    });

    it('parses WHERE n._id = $param', () => {
      const q = parseCypher('MATCH (c:Company) WHERE c._id = $id RETURN c.name');
      const w = q.where as any;
      expect(w.operator).toBe('=');
      expect(w.left).toEqual(prop('c', '_id'));
      expect(w.right).toEqual({ kind: 'parameter', name: 'id' });
    });
  });

  describe('parameter on RHS of IN (for array params)', () => {
    // Parser-level: parameter refs should be accepted where a list is expected.
    // This is a prerequisite for array params to work end-to-end.
    it('parses WHERE x IN $listParam', () => {
      const q = parseCypher('MATCH (c:Company) WHERE c.stage IN $stages RETURN c.name');
      expect(q.where!.kind).toBe('in');
      const inExpr = q.where as any;
      expect(inExpr.negated).toBe(false);
      expect(inExpr.list).toEqual({ kind: 'parameter', name: 'stages' });
    });

    it('parses WHERE x NOT IN $listParam', () => {
      const q = parseCypher('MATCH (c:Company) WHERE c.stage NOT IN $stages RETURN c.name');
      expect(q.where!.kind).toBe('in');
      expect((q.where as any).negated).toBe(true);
      expect((q.where as any).list).toEqual({ kind: 'parameter', name: 'stages' });
    });
  });

  describe('full queries', () => {
    it('parses a complex query', () => {
      const q = parseCypher(
        "MATCH (c:Company)-[:has_round]->(r:FundingRound)<-[:invested_in]-(i:Investor) " +
          "WHERE r.amount > 10000000 AND c.name CONTAINS 'tech' " +
          'RETURN c.name, r.amount, i.name AS investor ' +
          'ORDER BY r.amount DESC ' +
          'LIMIT 20',
      );

      expect(q.match.patterns[0].elements).toHaveLength(5);
      expect(q.where!.kind).toBe('binary');
      expect((q.where as any).operator).toBe('AND');
      expect(q.return.items).toHaveLength(3);
      expect(q.return.items[2].alias).toBe('investor');
      expect(q.orderBy).toHaveLength(1);
      expect(q.limit).toBe(20);
    });

    it('parses the original failing co-investor query', () => {
      const q = parseCypher(
        "MATCH (vc:`VC Firm` {Name: 'Tiny VC'}) " +
          'MATCH (vc)<-[:`Investment By Firm`]-(inv1:Investment)-[:`Investment In Round`]->(round:`Funding Round`) ' +
          'MATCH (round)<-[:`Investment In Round`]-(inv2:Investment)-[:`Investment By Firm`]->(other_vc:`VC Firm`) ' +
          "WHERE other_vc.Name <> 'Tiny VC' " +
          'RETURN DISTINCT round.`Round Name` AS funding_round, round.Date AS round_date, other_vc.Name AS co_investor ' +
          'ORDER BY round.Date DESC ' +
          'LIMIT 20',
      );
      expect(q.match.patterns).toHaveLength(3);
      expect(q.return.distinct).toBe(true);
      expect(q.return.items).toHaveLength(3);
      expect(q.return.items[0].alias).toBe('funding_round');
      const firstNode = q.match.patterns[0].elements[0] as NodePattern;
      expect(firstNode.label).toBe('VC Firm');
      expect(firstNode.properties).toEqual([{ key: 'Name', value: lit('Tiny VC') }]);
    });
  });
});

describe('parseAnyCypher — mutation queries', () => {
  describe('SET clause', () => {
    it('parses MATCH + SET', () => {
      const q = parseAnyCypher("MATCH (c:Company) WHERE c.name = 'Acme' SET c.status = 'Acquired'");
      expect(isMutation(q)).toBe(true);
      const m = q as MutationCypherQuery;
      expect(m.match).toBeDefined();
      expect(m.mutations).toHaveLength(1);
      const set = m.mutations[0] as SetClause;
      expect(set.kind).toBe('set');
      expect(set.items).toHaveLength(1);
      expect(set.items[0].target).toEqual(prop('c', 'status'));
      expect(set.items[0].value).toEqual(lit('Acquired'));
    });

    it('parses SET with multiple assignments', () => {
      const q = parseAnyCypher(
        "MATCH (c:Company) SET c.status = 'Acquired', c.active = FALSE",
      );
      const m = q as MutationCypherQuery;
      const set = m.mutations[0] as SetClause;
      expect(set.items).toHaveLength(2);
      expect(set.items[1].target).toEqual(prop('c', 'active'));
      expect(set.items[1].value).toEqual(lit(false));
    });

    it('parses SET with expression values', () => {
      const q = parseAnyCypher('MATCH (c:Company) SET c.updated = date()');
      const m = q as MutationCypherQuery;
      const set = m.mutations[0] as SetClause;
      expect(set.items[0].value).toEqual({
        kind: 'function_call',
        name: 'DATE',
        args: [],
      });
    });

    it('parses SET with RETURN', () => {
      const q = parseAnyCypher(
        "MATCH (c:Company) SET c.status = 'X' RETURN c.name, c.status",
      );
      const m = q as MutationCypherQuery;
      expect(m.return).toBeDefined();
      expect(m.return!.items).toHaveLength(2);
    });

    it('parses multiple SET clauses in sequence', () => {
      const q = parseAnyCypher(
        "MATCH (c:Company) SET c.x = 1 SET c.y = 2",
      );
      const m = q as MutationCypherQuery;
      expect(m.mutations).toHaveLength(2);
      expect(m.mutations[0].kind).toBe('set');
      expect(m.mutations[1].kind).toBe('set');
    });
  });

  describe('DELETE clause', () => {
    it('parses MATCH + DELETE', () => {
      const q = parseAnyCypher('MATCH (c:Company) DELETE c');
      const m = q as MutationCypherQuery;
      const del = m.mutations[0] as DeleteClause;
      expect(del.kind).toBe('delete');
      expect(del.variables).toEqual(['c']);
      expect(del.detach).toBe(false);
    });

    it('parses DETACH DELETE', () => {
      const q = parseAnyCypher('MATCH (c:Company) DETACH DELETE c');
      const m = q as MutationCypherQuery;
      const del = m.mutations[0] as DeleteClause;
      expect(del.detach).toBe(true);
    });

    it('parses DELETE with multiple variables', () => {
      const q = parseAnyCypher('MATCH (a:A)-[r:R]->(b:B) DELETE a, r, b');
      const m = q as MutationCypherQuery;
      const del = m.mutations[0] as DeleteClause;
      expect(del.variables).toEqual(['a', 'r', 'b']);
    });
  });

  describe('REMOVE clause', () => {
    it('parses REMOVE single property', () => {
      const q = parseAnyCypher('MATCH (c:Company) REMOVE c.status');
      const m = q as MutationCypherQuery;
      const rem = m.mutations[0] as RemoveClause;
      expect(rem.kind).toBe('remove');
      expect(rem.properties).toEqual([prop('c', 'status')]);
    });

    it('parses REMOVE multiple properties', () => {
      const q = parseAnyCypher('MATCH (c:Company) REMOVE c.status, c.oldField');
      const m = q as MutationCypherQuery;
      const rem = m.mutations[0] as RemoveClause;
      expect(rem.properties).toHaveLength(2);
    });
  });

  describe('CREATE clause', () => {
    it('parses standalone CREATE node', () => {
      const q = parseAnyCypher("CREATE (c:Company {Name: 'Acme'})");
      expect(isMutation(q)).toBe(true);
      const m = q as MutationCypherQuery;
      expect(m.match).toBeUndefined();
      expect(m.mutations).toHaveLength(1);
      const create = m.mutations[0] as CreateClause;
      expect(create.kind).toBe('create');
      expect(create.patterns).toHaveLength(1);
      const n = create.patterns[0].elements[0] as NodePattern;
      expect(n.label).toBe('Company');
      expect(n.properties).toEqual([{ key: 'Name', value: lit('Acme') }]);
    });

    it('parses CREATE with relationship', () => {
      const q = parseAnyCypher(
        "CREATE (c:Company {Name: 'Acme'})-[:Located In]->(city:City {Name: 'SF'})",
      );
      const m = q as MutationCypherQuery;
      const create = m.mutations[0] as CreateClause;
      expect(create.patterns[0].elements).toHaveLength(3);
    });

    it('parses MATCH + CREATE', () => {
      const q = parseAnyCypher(
        "MATCH (c:Company {Name: 'Acme'}) CREATE (c)-[:Located In]->(city:City {Name: 'SF'})",
      );
      const m = q as MutationCypherQuery;
      expect(m.match).toBeDefined();
      expect(m.mutations).toHaveLength(1);
      expect(m.mutations[0].kind).toBe('create');
    });

    it('parses CREATE with RETURN', () => {
      const q = parseAnyCypher("CREATE (c:Company {Name: 'Acme'}) RETURN c.Name");
      const m = q as MutationCypherQuery;
      expect(m.return).toBeDefined();
      expect(m.return!.items).toHaveLength(1);
    });
  });

  describe('MERGE clause', () => {
    it('parses simple MERGE', () => {
      const q = parseAnyCypher("MERGE (c:Company {Name: 'Acme'})");
      const m = q as MutationCypherQuery;
      const merge = m.mutations[0] as MergeClause;
      expect(merge.kind).toBe('merge');
      expect(merge.pattern.elements).toHaveLength(1);
      const n = merge.pattern.elements[0] as NodePattern;
      expect(n.label).toBe('Company');
      expect(n.properties).toEqual([{ key: 'Name', value: lit('Acme') }]);
    });

    it('parses MERGE with ON CREATE SET', () => {
      const q = parseAnyCypher(
        "MERGE (c:Company {Name: 'Acme'}) ON CREATE SET c.Status = 'New'",
      );
      const m = q as MutationCypherQuery;
      const merge = m.mutations[0] as MergeClause;
      expect(merge.onCreateSet).toHaveLength(1);
      expect(merge.onCreateSet![0].target).toEqual(prop('c', 'Status'));
      expect(merge.onCreateSet![0].value).toEqual(lit('New'));
    });

    it('parses MERGE with ON MATCH SET', () => {
      const q = parseAnyCypher(
        "MERGE (c:Company {Name: 'Acme'}) ON MATCH SET c.LastSeen = date()",
      );
      const m = q as MutationCypherQuery;
      const merge = m.mutations[0] as MergeClause;
      expect(merge.onMatchSet).toHaveLength(1);
      expect(merge.onMatchSet![0].value).toEqual({
        kind: 'function_call',
        name: 'DATE',
        args: [],
      });
    });

    it('parses MERGE with both ON CREATE and ON MATCH', () => {
      const q = parseAnyCypher(
        "MERGE (c:Company {Name: 'Acme'}) " +
          "ON CREATE SET c.Status = 'New' " +
          "ON MATCH SET c.Status = 'Existing'",
      );
      const m = q as MutationCypherQuery;
      const merge = m.mutations[0] as MergeClause;
      expect(merge.onCreateSet).toHaveLength(1);
      expect(merge.onMatchSet).toHaveLength(1);
    });

    it('parses MERGE on edge pattern', () => {
      const q = parseAnyCypher(
        'MATCH (a:Person), (b:Company) MERGE (a)-[:Works At]->(b)',
      );
      const m = q as MutationCypherQuery;
      const merge = m.mutations[0] as MergeClause;
      expect(merge.pattern.elements).toHaveLength(3);
    });
  });

  describe('mixed mutations', () => {
    it('parses SET + DELETE in sequence', () => {
      const q = parseAnyCypher(
        "MATCH (c:Company) SET c.archived = TRUE DELETE c",
      );
      const m = q as MutationCypherQuery;
      expect(m.mutations).toHaveLength(2);
      expect(m.mutations[0].kind).toBe('set');
      expect(m.mutations[1].kind).toBe('delete');
    });

    it('parses CREATE + SET', () => {
      const q = parseAnyCypher(
        "CREATE (c:Company {Name: 'Acme'}) SET c.Status = 'Active'",
      );
      const m = q as MutationCypherQuery;
      expect(m.mutations).toHaveLength(2);
      expect(m.mutations[0].kind).toBe('create');
      expect(m.mutations[1].kind).toBe('set');
    });
  });

  describe('read queries still work through parseAnyCypher', () => {
    it('returns CypherQuery for read-only queries', () => {
      const q = parseAnyCypher('MATCH (c:Company) RETURN c.name');
      expect(isMutation(q)).toBe(false);
    });
  });

  describe('parseCypher rejects mutations', () => {
    it('rejects SET', () => {
      expect(() => parseCypher("MATCH (c:Company) SET c.x = 1")).toThrow(ParseError);
    });

    it('rejects CREATE', () => {
      expect(() => parseCypher("CREATE (c:Company {Name: 'Acme'})")).toThrow(ParseError);
    });
  });
});
