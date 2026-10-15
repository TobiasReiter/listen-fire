// The pure catalog builder every shell shares: a remote install's listen
// declarations reach the checker as the same vocabulary a built-in's do, so a
// listen config the adapter would never route is refused.

import { checkProgram, fromCatalogSnapshot, parseProgram } from 'movement-lang';
import { buildCatalogSnapshot } from 'movement-engine/services/translation_graph/movement/catalog_snapshot';

import { RemoteAdapterManifestFile, remoteAdapterManifest } from '../../adapters/remote/manifest';

const file = RemoteAdapterManifestFile.parse({
  protocolVersion: 2,
  adapterType: 'acme_crm',
  baseUrl: 'https://crm.example/adapter',
  authStrategy: { kind: 'bearer' },
  supportedTriggers: ['webhook'],
  subscribableEvents: ['company.created', 'company.updated'],
  listenConfig: [{ key: 'schedule', format: 'cron' }],
  runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
  methods: ['describe'],
});

const snapshot = buildCatalogSnapshot({
  adapters: [{ manifest: remoteAdapterManifest(file) }],
  credentials: {},
  plugins: {},
});

function codes(listen: string): string[] {
  const source = `import { acme_crm } from adapters\ncrm = acme_crm()\nmovement welcome() {}\n${listen}\n`;
  return checkProgram(parseProgram(source), fromCatalogSnapshot(snapshot)).map((d) => d.code);
}

describe('buildCatalogSnapshot over a remote manifest', () => {
  it('projects the listen declarations into the listen-config vocabulary', () => {
    expect(snapshot.adapters.acme_crm).toMatchObject({
      constructionArgs: [],
      canFire: true,
      triggerConfig: ['events', 'schedule'],
      triggerConfigOptions: { events: ['company.created', 'company.updated'] },
      triggerConfigFormats: { schedule: 'cron' },
      schemaShape: 'introspected',
      schemas: {},
    });
  });

  it('checks a declared event clean and refuses an undeclared key or event', () => {
    expect(codes('listen to crm { events: ["company.created"] } fire welcome')).not.toContain('MOV_LISTEN_BAD_CONFIG');
    expect(codes('listen to crm { colour: "red" } fire welcome')).toContain('MOV_LISTEN_BAD_CONFIG');
    expect(codes('listen to crm { events: ["company.deleted"] } fire welcome')).toContain('MOV_LISTEN_BAD_CONFIG');
  });

  it('leaves a manifest that declares nothing unchecked', () => {
    const bare = buildCatalogSnapshot({
      adapters: [{ manifest: remoteAdapterManifest({ ...file, subscribableEvents: undefined, listenConfig: undefined }) }],
      credentials: {},
      plugins: {},
    });
    expect(bare.adapters.acme_crm?.triggerConfig).toBeUndefined();
  });
});
