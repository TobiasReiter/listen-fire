// The module additions to protocol version 2 (credentials, declared inbound
// signatures, poll and periodic tasks) are a minor: a message an older client
// or server sends still validates, and a new one round-trips through the
// schemas unchanged.
import {
  INBOUND_SIGNATURE_SCHEMES,
  METHODS,
  PROTOCOL_VERSION,
  RpcRequest,
  RpcResponse,
  WireManifestResult,
} from '../index';

const OLD_MANIFEST = {
  protocolVersion: 2,
  adapterType: 'acme_crm',
  supportedTriggers: ['webhook'],
  runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
  methods: ['listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated', 'createRecord', 'updateRecord', 'deleteRecord'],
};

const MODULE_MANIFEST = {
  ...OLD_MANIFEST,
  adapterType: 'attio',
  methods: [...OLD_MANIFEST.methods, 'poll', 'refreshCredential', 'runPeriodic', 'preprocessInbound'],
  credentials: [
    {
      name: 'attio',
      kind: 'oauth2',
      fields: [{ name: 'workspace_id', label: 'Workspace', secret: false }],
      oauth2: {
        authorizeUrl: 'https://app.attio.com/authorize',
        tokenUrl: 'https://app.attio.com/oauth/token',
        scopes: ['record_permission:read-write'],
        clientAuth: 'body',
        pkce: true,
        authorizeParams: { access_type: 'offline' },
      },
    },
    { name: 'attio_key', kind: 'static', fields: [{ name: 'api_key' }, { name: 'region', optional: true, secret: false }] },
  ],
  inbound: {
    providerKey: 'attio',
    scheme: 'attio',
    signatureHeaders: ['attio-signature', 'x-attio-signature'],
    intercepts: ['slack_url_verification'],
  },
  poll: { intervalSeconds: 300 },
  periodic: [{ name: 'renew_webhook', intervalSeconds: 86_400 }],
};

describe('a version-2 message from before the module additions', () => {
  it('validates: a manifest that declares nothing new', () => {
    expect(WireManifestResult.parse(OLD_MANIFEST)).toEqual(OLD_MANIFEST);
  });

  it('validates: a request with no credential, and both response arms with no update', () => {
    const request = { protocolVersion: PROTOCOL_VERSION, method: 'describe', cacheScopeId: 'c0ffee', params: { typeId: 'Company' } };
    expect(RpcRequest.parse(request)).toEqual(request);
    expect(RpcResponse.parse({ ok: true, result: null })).toEqual({ ok: true, result: null });
    const failure = { ok: false, error: { code: 'adapter_error', message: 'CRM timed out', retryable: true } };
    expect(RpcResponse.parse(failure)).toEqual(failure);
  });
});

describe('a module manifest', () => {
  it('round-trips every declaration', () => {
    const parsed = WireManifestResult.parse(MODULE_MANIFEST);
    expect(parsed).toEqual(MODULE_MANIFEST);
    expect(WireManifestResult.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(MODULE_MANIFEST);
  });

  it('accepts each declared signature scheme', () => {
    for (const scheme of INBOUND_SIGNATURE_SCHEMES) {
      const manifest = { ...MODULE_MANIFEST, inbound: { ...MODULE_MANIFEST.inbound, scheme } };
      expect(WireManifestResult.safeParse(manifest).success).toBe(true);
    }
    expect([...INBOUND_SIGNATURE_SCHEMES]).toEqual([
      'hmac_sha256_hex',
      'airtable_mac',
      'attio',
      'affinity_hex_or_b64',
      'slack_v0',
      'telegram_secret_token',
      'remote',
    ]);
  });

  const refusal = (manifest: unknown) => {
    const result = WireManifestResult.safeParse(manifest);
    if (result.success) throw new Error('expected the manifest to be refused');
    return result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  };

  it('refuses a scheme or an intercept the host does not know, rather than not verifying', () => {
    expect(refusal({ ...MODULE_MANIFEST, inbound: { ...MODULE_MANIFEST.inbound, scheme: 'md5' } })[0]).toMatch(/^inbound\.scheme/);
    expect(refusal({ ...MODULE_MANIFEST, inbound: { ...MODULE_MANIFEST.inbound, intercepts: ['ping'] } })[0]).toMatch(/^inbound\.intercepts/);
  });

  it('refuses a signature header that is not a lower-case header name, and an empty list', () => {
    expect(refusal({ ...MODULE_MANIFEST, inbound: { ...MODULE_MANIFEST.inbound, signatureHeaders: ['Attio-Signature'] } })[0]).toMatch(
      /lower-case header name/,
    );
    expect(refusal({ ...MODULE_MANIFEST, inbound: { ...MODULE_MANIFEST.inbound, signatureHeaders: [] } })[0]).toMatch(/^inbound\.signatureHeaders/);
  });

  it('refuses an OAuth 2 credential without its OAuth 2 declaration', () => {
    const { oauth2: _omitted, ...bare } = MODULE_MANIFEST.credentials[0];
    expect(refusal({ ...MODULE_MANIFEST, credentials: [bare] })[0]).toMatch(/^credentials\.0\.oauth2/);
  });

  it('refuses a declaration without its method, and a method without its declaration', () => {
    const without = (method: string) => MODULE_MANIFEST.methods.filter((name) => name !== method);
    expect(refusal({ ...MODULE_MANIFEST, methods: without('poll') })).toEqual(['methods: declares `poll` but does not list `poll` in methods']);
    expect(refusal({ ...MODULE_MANIFEST, methods: without('runPeriodic') })).toEqual([
      'methods: declares `periodic` but does not list `runPeriodic` in methods',
    ]);
    expect(refusal({ ...OLD_MANIFEST, methods: [...OLD_MANIFEST.methods, 'poll'] })).toEqual([
      'poll: lists `poll` in methods but declares no `poll`',
    ]);
    expect(refusal({ ...OLD_MANIFEST, methods: [...OLD_MANIFEST.methods, 'refreshCredential'] })).toEqual([
      'credentials: lists `refreshCredential` in methods but declares no `credentials`',
    ]);
  });

  it('declares a credential without `refreshCredential`: the host refreshes OAuth 2 itself', () => {
    const methods = MODULE_MANIFEST.methods.filter((name) => name !== 'refreshCredential');
    expect(WireManifestResult.safeParse({ ...MODULE_MANIFEST, methods }).success).toBe(true);
  });

  it('refuses a credential or a periodic task declared twice', () => {
    const twice = { ...MODULE_MANIFEST, credentials: [MODULE_MANIFEST.credentials[1], MODULE_MANIFEST.credentials[1]] };
    expect(refusal(twice)).toEqual(['credentials: `attio_key` is declared twice']);
    const periodic = [...MODULE_MANIFEST.periodic, ...MODULE_MANIFEST.periodic];
    expect(refusal({ ...MODULE_MANIFEST, periodic })).toEqual(['periodic: `renew_webhook` is declared twice']);
  });
});

describe('the credential on the envelope', () => {
  const credential = { name: 'attio', fields: { access_token: 'at-1', refresh_token: 'rt-1', expires_at: '2026-10-17T12:00:00.000Z' } };
  const update = { name: 'attio', fields: { access_token: 'at-2', refresh_token: 'rt-2' } };

  it('round-trips a request carrying the resolved credential', () => {
    const request = { protocolVersion: PROTOCOL_VERSION, method: 'poll', cacheScopeId: 's', params: { config: {} }, credential };
    expect(RpcRequest.parse(JSON.parse(JSON.stringify(request)))).toEqual(request);
  });

  it('round-trips an update on a success and on a failure, so a rotated token is never lost', () => {
    const success = { ok: true, result: { events: [] }, credentialUpdate: update };
    expect(RpcResponse.parse(success)).toEqual(success);
    const failure = { ok: false, error: { code: 'adapter_error', message: 'refused', retryable: false }, credentialUpdate: update };
    expect(RpcResponse.parse(failure)).toEqual(failure);
  });

  it('refuses a field that is not a string', () => {
    expect(RpcRequest.safeParse({ protocolVersion: '2', method: 'poll', cacheScopeId: 's', params: {}, credential: { name: 'a', fields: { expires_in: 3600 } } }).success).toBe(
      false,
    );
  });
});

describe('the module methods', () => {
  it('poll: a listen config and checkpoint in, events and the next checkpoint out', () => {
    const params = { config: { every: 600 }, checkpoint: { since: '2026-10-17' } };
    expect(METHODS.poll.params.parse(params)).toEqual(params);
    expect(METHODS.poll.params.parse({ config: {} })).toEqual({ config: {} });
    const result = { events: [{ payload: { id: 'n-1' }, externalId: 'n-1', tag: 'note.created' }], checkpoint: { since: '2026-10-18' } };
    expect(METHODS.poll.result.parse(result)).toEqual(result);
  });

  it('refreshCredential: the changed fields out', () => {
    expect(METHODS.refreshCredential.params.parse({})).toEqual({});
    expect(METHODS.refreshCredential.result.parse({ fields: { access_token: 'at-2' } })).toEqual({ fields: { access_token: 'at-2' } });
  });

  it('runPeriodic: a declared task by name, answered with null', () => {
    expect(METHODS.runPeriodic.params.parse({ name: 'renew_webhook' })).toEqual({ name: 'renew_webhook' });
    expect(METHODS.runPeriodic.result.parse(null)).toBeNull();
  });
});

// A plugin module: its plugins declared as one package, called by
// `invokePlugin` (ev3-kit; within version 2, no bump).
const PLUGIN_MANIFEST = {
  ...OLD_MANIFEST,
  adapterType: 'web',
  supportedTriggers: [],
  methods: ['manifest', 'invokePlugin'],
  plugins: {
    package: '@lf/web',
    plugins: [
      {
        name: 'fetch-url',
        spec: {
          args: ['url', 'email'],
          priced: false,
          argTypes: { url: 'text', email: 'text' },
          requiredArgs: ['url'],
          effects: { reads: ['the web'] },
          output: { kind: 'value', type: 'text' },
        },
      },
    ],
  },
};

describe('a plugin module', () => {
  it('round-trips its package of plugins', () => {
    expect(WireManifestResult.parse(PLUGIN_MANIFEST)).toEqual(PLUGIN_MANIFEST);
  });

  it('refuses plugins without `invokePlugin`, `invokePlugin` without plugins, and a plugin declared twice', () => {
    expect(WireManifestResult.safeParse({ ...PLUGIN_MANIFEST, methods: ['manifest'] }).success).toBe(false);
    const { plugins: _plugins, ...bare } = PLUGIN_MANIFEST;
    expect(WireManifestResult.safeParse(bare).success).toBe(false);
    const twice = { ...PLUGIN_MANIFEST.plugins, plugins: [...PLUGIN_MANIFEST.plugins.plugins, { ...PLUGIN_MANIFEST.plugins.plugins[0], name: 'fetch_url' }] };
    expect(WireManifestResult.safeParse({ ...PLUGIN_MANIFEST, plugins: twice }).success).toBe(false);
  });

  it('refuses an empty package and a plugin name a program could not spell', () => {
    expect(WireManifestResult.safeParse({ ...PLUGIN_MANIFEST, plugins: { package: '@lf/web', plugins: [] } }).success).toBe(false);
    const badName = { package: '@lf/web', plugins: [{ ...PLUGIN_MANIFEST.plugins.plugins[0], name: 'Fetch URL' }] };
    expect(WireManifestResult.safeParse({ ...PLUGIN_MANIFEST, plugins: badName }).success).toBe(false);
  });

  it('invokePlugin: a plugin by name with its arguments in, what it added out', () => {
    const params = { name: 'fetch-url', config: { url: 'https://acme.test' }, extractedContext: {} };
    expect(METHODS.invokePlugin.params.parse(params)).toEqual(params);
    const result = { text: 'page', data: { title: 'Acme' }, records: [{ url: 'https://acme.test' }], outcome: 'fetched 1', costMicrodollars: 1200 };
    expect(METHODS.invokePlugin.result.parse(result)).toEqual(result);
    expect(METHODS.invokePlugin.result.parse({})).toEqual({});
    expect(METHODS.invokePlugin.result.safeParse({ costMicrodollars: -1 }).success).toBe(false);
  });
});
