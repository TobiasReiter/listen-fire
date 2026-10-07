// The browser path to the movement parser: the listeners panel parses as it
// renders, so before the parser loads it must not render at all, and once
// loadParser() has fetched the artifact it parses. Node would load the parser
// from disk as the module loads; a `window` while the registry below loads
// makes the loader take the browser's path instead.
import fs from 'fs';
import path from 'path';

// next.config.ts injects the content-hashed URL; a test names its own.
process.env.NEXT_PUBLIC_PARSER_URL = '/movement_parser.0123456789ab.wasm';

import type { ListenersPanelProps } from '@/components/movements/listeners-panel';

type Modules = {
  react: typeof import('react');
  server: typeof import('react-dom/server');
  lang: typeof import('movement-lang');
  provider: typeof import('../parser-provider');
  panel: typeof import('@/components/movements/listeners-panel');
};

function loadAsBrowser(): Modules {
  Reflect.set(globalThis, 'window', globalThis);
  try {
    let modules: Modules | undefined;
    jest.isolateModules(() => {
      modules = {
        react: require('react'),
        server: require('react-dom/server'),
        lang: require('movement-lang'),
        provider: require('../parser-provider'),
        panel: require('@/components/movements/listeners-panel'),
      };
    });
    if (modules === undefined) throw new Error('isolateModules did not run');
    return modules;
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
  }
}

const SOURCE = `import { email } from adapters

inbox = email()

movement Triage(item: <inbox-[:message]->>) {
}

listen to inbox { key: "deals" } fire Triage
`;

const PANEL_PROPS: ListenersPanelProps = {
  source: SOURCE,
  serverListeners: [],
  suggestionMessages: [],
  saving: false,
  onPause: () => {},
  onResume: () => {},
  onAddListener: () => {},
  onOpenActivity: () => {},
};

function artifact(): Uint8Array {
  return fs.readFileSync(path.join(__dirname, '../../../../../packages/movement-lang/wasm/movement_parser.wasm'));
}

describe('the browser parser provider', () => {
  const { react, server, lang, provider, panel } = loadAsBrowser();
  const panelElement = react.createElement(panel.ListenersPanel, PANEL_PROPS);
  const gated = react.createElement(provider.ParserProvider, null, panelElement);

  afterEach(() => jest.restoreAllMocks());

  it('holds the listeners panel back until the parser loads, which it must', () => {
    expect(lang.isParserReady()).toBe(false);
    expect(server.renderToStaticMarkup(gated)).toBe('');
    expect(() => server.renderToStaticMarkup(panelElement)).toThrow(lang.MovementParserNotReady);
    expect(() => server.renderToStaticMarkup(panelElement)).toThrow('await initParser()');
  });

  it('fetches the artifact from public/, then renders the panel from the parsed script', async () => {
    const fetched = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(artifact()));
    await provider.loadParser();
    expect(fetched).toHaveBeenCalledWith('/movement_parser.0123456789ab.wasm');
    expect(lang.isParserReady()).toBe(true);

    const html = server.renderToStaticMarkup(gated);
    expect(html).toContain('data-testid="listener-card-pending"');
    expect(html).toContain('Triage');
    expect(html).toContain('deals');
  });
});
