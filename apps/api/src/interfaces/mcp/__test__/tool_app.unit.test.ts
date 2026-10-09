import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import type { LocalApiCall, TopLevelTool, ToolApp } from '../server';

import { APP_MIME_TYPE, buildMcpServer } from '../server';

/**
 * The in-chat view, asserted where a host actually reads it.
 *
 * Every claim here is made against a real MCP client talking to the real
 * server, because the wire is the only place the declaration exists: the host
 * fetches nothing and asks nothing if `_meta` is spelled wrong, and the only
 * symptom is an empty panel. Asserting on our own registration object would
 * prove we called a function, not that a client is told anything.
 */

const RESOURCE_URI = 'ui://listen-fire/test-view';

const app: ToolApp = {
  resourceUri: RESOURCE_URI,
  title: 'Test view',
  description: 'A view for a test',
  html: async () => '<!doctype html><html><body>drawn</body></html>',
  data: async () => ({ 'dev.listen-fire/test': { drawn: true } }),
};

const base = {
  title: 'Read a thing',
  description: 'reads a thing',
  annotations: { readOnlyHint: true },
  inputSchema: { q: z.string() },
} satisfies Omit<TopLevelTool, 'endpoint' | 'handler'>;

const answered: LocalApiCall = async () => ({
  content: [{ type: 'text', text: '{"ok":true}' }],
});

async function connect(tools: Record<string, TopLevelTool>, callApi: LocalApiCall = answered) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer({ name: 'test', domain: 'automation', genericApiTools: false, tools }, callApi);
  const client = new Client({ name: 'test-host', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const withApp = { ...base, endpoint: { method: 'GET' as const, path: '/v1/things' }, app };
const withoutApp = { ...base, endpoint: { method: 'GET' as const, path: '/v1/things' } };

describe('a tool that declares an in-chat view', () => {
  it('names the view on the tool, in both spellings the extension defines', async () => {
    const client = await connect({ readThing: withApp });
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'readThing');

    expect(tool?._meta).toMatchObject({
      ui: { resourceUri: RESOURCE_URI },
      'ui/resourceUri': RESOURCE_URI,
    });
  });

  it('serves the view as one HTML document under the extension’s mime type', async () => {
    const client = await connect({ readThing: withApp });

    const { resources } = await client.listResources();
    expect(resources).toEqual([
      expect.objectContaining({ uri: RESOURCE_URI, mimeType: APP_MIME_TYPE }),
    ]);

    const read = await client.readResource({ uri: RESOURCE_URI });
    expect(read.contents).toEqual([
      { uri: RESOURCE_URI, mimeType: 'text/html;profile=mcp-app', text: expect.stringContaining('<!doctype html>') },
    ]);
  });

  it('registers the view once when several tools share it', async () => {
    const client = await connect({ readThing: withApp, readOther: { ...withApp, title: 'Read another' } });
    const { resources } = await client.listResources();
    expect(resources).toHaveLength(1);
  });

  it('hands the view its data on the result, leaving the text alone', async () => {
    const client = await connect({ readThing: withApp });
    const result = await client.callTool({ name: 'readThing', arguments: { q: 'x' } });

    expect(result.content).toEqual([{ type: 'text', text: '{"ok":true}' }]);
    expect(result._meta).toEqual({ 'dev.listen-fire/test': { drawn: true } });
  });

  it('says nothing extra when the data can’t be produced', async () => {
    const client = await connect({
      readThing: { ...withApp, app: { ...app, data: async () => { throw new Error('no story'); } } },
    });
    const result = await client.callTool({ name: 'readThing', arguments: { q: 'x' } });

    expect(result.content).toEqual([{ type: 'text', text: '{"ok":true}' }]);
    expect(result._meta).toBeUndefined();
  });

  it('draws nothing for a failed call', async () => {
    const failing: LocalApiCall = async () => ({
      content: [{ type: 'text', text: '{"error":"nope"}' }],
      isError: true,
    });
    const client = await connect({ readThing: withApp }, failing);
    const result = await client.callTool({ name: 'readThing', arguments: { q: 'x' } });

    expect(result.isError).toBe(true);
    expect(result._meta).toBeUndefined();
  });
});

describe('every other tool', () => {
  it('is offered and answered exactly as before', async () => {
    const client = await connect({ readThing: withoutApp });

    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'readThing')?._meta).toBeUndefined();

    const result = await client.callTool({ name: 'readThing', arguments: { q: 'x' } });
    expect(result.content).toEqual([{ type: 'text', text: '{"ok":true}' }]);
    expect(result._meta).toBeUndefined();
  });

  it('leaves the server with no views to serve', async () => {
    const client = await connect({ readThing: withoutApp });
    await expect(client.listResources()).rejects.toThrow();
  });
});
