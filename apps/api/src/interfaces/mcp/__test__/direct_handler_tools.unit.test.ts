import { z } from 'zod';

import type { TopLevelTool } from '../server';

import { createMcpRouter } from '../server';

const base = {
  title: 'Read a thing',
  description: 'reads a thing',
  annotations: { readOnlyHint: true },
  inputSchema: { q: z.string() },
} satisfies Omit<TopLevelTool, 'endpoint' | 'handler'>;

const make = (tools: Record<string, TopLevelTool>) =>
  createMcpRouter({ name: 'test', domain: 'valuations', tools });

describe('TopLevelTool endpoint/handler exclusivity (boot guard)', () => {
  it('accepts a handler-only tool', () => {
    expect(() =>
      make({ readThing: { ...base, handler: async () => ({ content: [{ type: 'text', text: '{}' }] }) } }),
    ).not.toThrow();
  });

  it('accepts an endpoint-only tool', () => {
    expect(() =>
      make({ readThing: { ...base, endpoint: { method: 'GET', path: '/v1/valuations/things' } } }),
    ).not.toThrow();
  });

  it('rejects a tool with neither endpoint nor handler', () => {
    expect(() => make({ readThing: { ...base } as TopLevelTool })).toThrow(/exactly one/);
  });

  it('rejects a tool with both endpoint and handler', () => {
    expect(() =>
      make({
        readThing: {
          ...base,
          endpoint: { method: 'GET', path: '/v1/valuations/things' },
          handler: async () => ({ content: [{ type: 'text', text: '{}' }] }),
        },
      }),
    ).toThrow(/exactly one/);
  });
});
