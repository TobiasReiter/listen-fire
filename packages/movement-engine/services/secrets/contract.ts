// The secrets family's contract suite: one set of cases every store passes
// (the in-memory vault, the platform's encrypted credentials table, lf's
// plain and SOPS files and the environment). Each case drives the store only
// through `createSecretsFamily`, as every shell does.
//
// Runner-agnostic: each case is a name and an async body that throws on
// failure (node:assert), so jest and node:test both wrap the same list.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSecretsFamily, SecretMissing, SecretVersionConflict, withSecret, type SecretFields, type SecretsBackend, type SecretsFamily } from './family';
import { oauth2Refresher } from './oauth2';

export interface SecretsContractBackend {
  /** A handle on the store. */
  backend: SecretsBackend;
  /** A second handle on the same store, as another process would hold it. */
  sibling(): SecretsBackend;
  /** Store a new credential; returns its ref. */
  seed(fields: SecretFields): Promise<string>;
  /** A ref the store does not hold. */
  missingRef(): string;
  /** The store cannot keep a write-back beyond this process (the
   *  environment): it warns, and a sibling still reads the old fields. */
  readOnly?: boolean;
  /** Everything the store itself wrote outside the family while the case ran
   *  (its logs, its stderr), for the canary scan. */
  observed?(): string;
}

export interface SecretsContractCase {
  name: string;
  run(backend: SecretsContractBackend): Promise<void>;
}

const TOKEN_URL = 'https://tokens.example.test/oauth/token';

/** A fake token endpoint: counts its calls, answers after `delayMs`. */
function tokenEndpoint(options: { rotate?: boolean; delayMs?: number; fail?: (body: URLSearchParams) => string } = {}) {
  const forms: URLSearchParams[] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    const body = new URLSearchParams(String(init?.body ?? ''));
    forms.push(body);
    if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (options.fail !== undefined) return new Response(options.fail(body), { status: 400 });
    const n = forms.length;
    return Response.json({ access_token: `access-${n}`, expires_in: 3600, ...(options.rotate === true ? { refresh_token: `refresh-${n}` } : {}) });
  };
  return { forms, refresher: oauth2Refresher({ tokenUrl: TOKEN_URL, clientAuth: 'body', client: { clientId: 'client', clientSecret: 'client-secret' }, fetch: fakeFetch }) };
}

const STALE = { access_token: 'access-0', refresh_token: 'refresh-0', expires_at: '2000-01-01T00:00:00.000Z' };

function familyOf(store: SecretsBackend, warnings: string[] = []): SecretsFamily {
  return createSecretsFamily({ backend: store, warn: (message) => warnings.push(message) });
}

export const secretsContractCases: SecretsContractCase[] = [
  {
    name: 'resolve answers the stored fields',
    async run(b) {
      const ref = await b.seed({ api_key: 'key-1', workspace: 'w1' });
      const record = await familyOf(b.backend).resolve(ref);
      assert.deepEqual({ ...record.fields }, { api_key: 'key-1', workspace: 'w1' });
      assert.ok(record.version.length > 0);
    },
  },
  {
    name: 'resolve of a credential the store does not hold is SecretMissing',
    async run(b) {
      await assert.rejects(familyOf(b.backend).resolve(b.missingRef()), SecretMissing);
    },
  },
  {
    name: 'a write-back merges over the stored fields, keeps the ones it does not name, and moves the version',
    async run(b) {
      const ref = await b.seed({ access_token: 'a1', refresh_token: 'r1', workspace: 'w1' });
      const family = familyOf(b.backend);
      const before = await family.resolve(ref);
      const after = await family.writeBack(ref, { access_token: 'a2' }, before.version);
      assert.deepEqual({ ...after.fields }, { access_token: 'a2', refresh_token: 'r1', workspace: 'w1' });
      assert.notEqual(after.version, before.version);
      assert.deepEqual({ ...(await family.resolve(ref)).fields }, { ...after.fields });
      const elsewhere = await familyOf(b.sibling()).resolve(ref);
      assert.equal(elsewhere.fields.access_token, b.readOnly === true ? 'a1' : 'a2');
    },
  },
  {
    name: 'a write-back at a version the store has moved past is SecretVersionConflict, and changes nothing',
    async run(b) {
      const ref = await b.seed({ access_token: 'a1', refresh_token: 'r1' });
      const family = familyOf(b.backend);
      const seen = await family.resolve(ref);
      await family.writeBack(ref, { access_token: 'a2' }, seen.version);
      await assert.rejects(family.writeBack(ref, { access_token: 'a3' }, seen.version), SecretVersionConflict);
      assert.equal((await family.resolve(ref)).fields.access_token, 'a2');
    },
  },
  {
    name: 'a refresh stores the new access token and a rotated refresh_token',
    async run(b) {
      const ref = await b.seed({ ...STALE, workspace: 'w1' });
      const endpoint = tokenEndpoint({ rotate: true });
      const family = familyOf(b.backend);
      const seen = await family.resolve(ref);
      const after = await family.refresh(ref, { seenVersion: seen.version, refresher: endpoint.refresher });
      assert.equal(endpoint.forms.length, 1);
      assert.equal(endpoint.forms[0]?.get('refresh_token'), 'refresh-0');
      assert.equal(after.fields.access_token, 'access-1');
      assert.equal(after.fields.refresh_token, 'refresh-1');
      assert.equal(after.fields.workspace, 'w1');
      assert.ok(Date.parse(after.fields.expires_at ?? '') > Date.now());
      if (b.readOnly !== true) assert.equal((await familyOf(b.sibling()).resolve(ref)).fields.refresh_token, 'refresh-1');
    },
  },
  {
    name: 'a refresh whose provider does not rotate keeps the stored refresh_token',
    async run(b) {
      const ref = await b.seed(STALE);
      const endpoint = tokenEndpoint();
      const family = familyOf(b.backend);
      const after = await family.refresh(ref, { seenVersion: (await family.resolve(ref)).version, refresher: endpoint.refresher });
      assert.equal(after.fields.refresh_token, 'refresh-0');
      assert.equal(after.fields.access_token, 'access-1');
    },
  },
  {
    name: 'two concurrent refreshes in one process make one token call',
    async run(b) {
      const ref = await b.seed(STALE);
      const endpoint = tokenEndpoint({ rotate: true, delayMs: 50 });
      const family = familyOf(b.backend);
      const seen = await family.resolve(ref);
      const [one, two] = await Promise.all([
        family.refresh(ref, { seenVersion: seen.version, refresher: endpoint.refresher }),
        family.refresh(ref, { seenVersion: seen.version, refresher: endpoint.refresher }),
      ]);
      assert.equal(endpoint.forms.length, 1);
      assert.equal(one.fields.access_token, 'access-1');
      assert.equal(two.fields.access_token, 'access-1');
    },
  },
  {
    name: 'two concurrent refreshes from two handles on the store make one token call',
    async run(b) {
      if (b.readOnly === true) return; // nothing is shared between processes to refresh once
      const ref = await b.seed(STALE);
      const endpoint = tokenEndpoint({ rotate: true, delayMs: 50 });
      const here = familyOf(b.backend);
      const there = familyOf(b.sibling());
      const [seenHere, seenThere] = [await here.resolve(ref), await there.resolve(ref)];
      assert.equal(seenHere.version, seenThere.version);
      const [one, two] = await Promise.all([
        here.refresh(ref, { seenVersion: seenHere.version, refresher: endpoint.refresher }),
        there.refresh(ref, { seenVersion: seenThere.version, refresher: endpoint.refresher }),
      ]);
      assert.equal(endpoint.forms.length, 1);
      assert.equal(one.fields.access_token, 'access-1');
      assert.equal(two.fields.access_token, 'access-1');
      assert.equal(two.fields.refresh_token, 'refresh-1');
    },
  },
  {
    name: 'a call that fails unauthorized refreshes once and is retried with the new token',
    async run(b) {
      const ref = await b.seed({ access_token: 'access-0', refresh_token: 'refresh-0' });
      const endpoint = tokenEndpoint();
      const sent: string[] = [];
      const answer = await withSecret(
        familyOf(b.backend),
        ref,
        { refresher: endpoint.refresher, isUnauthorized: (error) => error instanceof Error && error.message === 'unauthorized' },
        async (record) => {
          sent.push(record.fields.access_token ?? '');
          if (record.fields.access_token === 'access-0') throw new Error('unauthorized');
          return 'answered';
        },
      );
      assert.equal(answer, 'answered');
      assert.deepEqual(sent, ['access-0', 'access-1']);
      assert.equal(endpoint.forms.length, 1);
    },
  },
  {
    name: 'a write-back the store cannot keep warns once per credential (only a read-only store warns)',
    async run(b) {
      const ref = await b.seed({ access_token: 'a1' });
      const warnings: string[] = [];
      const family = familyOf(b.backend, warnings);
      const first = await family.writeBack(ref, { access_token: 'a2' }, (await family.resolve(ref)).version);
      await family.writeBack(ref, { access_token: 'a3' }, first.version);
      assert.equal(warnings.length, b.readOnly === true ? 1 : 0, warnings.join('\n'));
      assert.equal((await family.resolve(ref)).fields.access_token, 'a3');
    },
  },
  {
    name: 'canary: no secret value reaches a warning, an error or the store\'s own output',
    async run(b) {
      const canary = (what: string) => `canary-${what}-${randomUUID()}`;
      const fields = { access_token: canary('access'), refresh_token: canary('refresh'), api_key: canary('key') };
      const ref = await b.seed({ ...fields, expires_at: STALE.expires_at });
      const warnings: string[] = [];
      const family = familyOf(b.backend, warnings);
      const seen = await family.resolve(ref);
      const texts: string[] = [];
      const collect = (error: unknown) => {
        texts.push(error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error));
        return true;
      };
      // The provider echoes the refresh token it was sent in its error body.
      const echo = tokenEndpoint({ fail: (body) => `{"error":"invalid_grant","refresh_token":"${body.get('refresh_token')}"}` });
      await assert.rejects(family.refresh(ref, { seenVersion: seen.version, refresher: echo.refresher }), collect);
      await family.writeBack(ref, { access_token: canary('written') }, seen.version).then((written) => {
        Object.assign(fields, { written: written.fields.access_token });
      });
      await assert.rejects(family.writeBack(ref, { access_token: canary('late') }, seen.version), collect);
      await assert.rejects(family.resolve(b.missingRef()), collect);
      const scanned = [...texts, ...warnings, b.observed?.() ?? ''].join('\n');
      for (const value of Object.values(fields)) assert.ok(!scanned.includes(value), `a secret value leaked:\n${scanned}`);
      assert.ok(!scanned.includes('canary-late'), `a refused value leaked:\n${scanned}`);
    },
  },
];
