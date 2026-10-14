// `exposeFile` — buffers a byte stream to S3 under the isolation prefix, records
// an `exposed_file` row, and returns a deployment-domain capability URL. The S3
// provider and the DB are mocked; the test asserts the wiring (prefix on upload,
// blob URL shape, row values).
//
// The row is TENANT data now (D55(a)), and the tenant comes from the ambient
// principal — so the calls run inside one. The principal is a MACHINE one
// (no `userId`) on purpose: the busiest caller is an adapter inside a movement
// fired by a webhook, which has a team and no person, and a stamp that reached
// for `ctx.user` would throw exactly there.

import { Readable } from 'node:stream';

import { runWithPrincipal, type Principal } from 'principal';

interface UploadOpts {
  filename: string;
  mimeType?: string;
  contentLength: number;
  keyPrefix?: string;
}
const uploadMock = jest.fn(async (_stream: unknown, _opts: UploadOpts) => ({
  objectUri: 's3://bucket/exposed/uuid-1/deck.pdf',
  checksum: 'abc',
}));

jest.mock('../../../../../adapters/registry', () => ({
  services: { document: { upload: uploadMock } },
}));

const insertedValues: Record<string, unknown> = {};
jest.mock('../../../../../lib/kysely', () => ({
  getAutomationsQb: () => ({
    insertInto: () => ({
      values: (v: Record<string, unknown>) => {
        Object.assign(insertedValues, v);
        return {
          returning: () => ({
            executeTakeFirstOrThrow: async () => ({ id: 'blob-1' }),
          }),
        };
      },
    }),
  }),
}));

import { exposeFile, EXPOSED_FILE_PREFIX } from '../expose';

const MACHINE: Principal = {
  teamId: 'team-7',
  access: 'write',
  scopes: ['*'],
  pinnedTeamId: 'team-7',
};

const expose = (input: Parameters<typeof exposeFile>[0]) =>
  runWithPrincipal(MACHINE, () => exposeFile(input));

describe('exposeFile', () => {
  beforeEach(() => {
    uploadMock.mockClear();
    for (const k of Object.keys(insertedValues)) delete insertedValues[k];
  });

  it('uploads under the isolation prefix and returns a Listen-Fire blob URL', async () => {
    // The URL's base comes from env; a developer's `.env` may set either
    // variable, so the test pins both rather than inherit the machine's.
    const prev = {
      oauth: process.env.OAUTH_REDIRECT_BASE_URL,
      pinned: process.env.EXPOSED_FILE_PUBLIC_BASE_URL,
    };
    process.env.OAUTH_REDIRECT_BASE_URL = 'https://api.example.test';
    delete process.env.EXPOSED_FILE_PUBLIC_BASE_URL;
    try {
      const result = await expose({
        stream: Readable.from('pdf-bytes'),
        filename: 'deck.pdf',
        contentType: 'application/pdf',
      });

      expect(result.url).toBe('https://api.example.test/api/files/blob/blob-1');
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // Uploaded with the prefix + the real byte length.
      const [stream, opts] = uploadMock.mock.calls[0];
      expect(stream).toBeInstanceOf(Readable);
      expect(opts.keyPrefix).toBe(EXPOSED_FILE_PREFIX);
      expect(opts.filename).toBe('deck.pdf');
      expect(opts.mimeType).toBe('application/pdf');
      expect(opts.contentLength).toBe(Buffer.byteLength('pdf-bytes'));

      // Row records the S3 handle, an expiry, and whose file it is.
      expect(insertedValues.object_uri).toBe('s3://bucket/exposed/uuid-1/deck.pdf');
      expect(insertedValues.content_type).toBe('application/pdf');
      expect(insertedValues.filename).toBe('deck.pdf');
      expect(insertedValues.expires_at).toBeInstanceOf(Date);
      expect(insertedValues.team_id).toBe('team-7');
    } finally {
      for (const [key, value] of [
        ['OAUTH_REDIRECT_BASE_URL', prev.oauth],
        ['EXPOSED_FILE_PUBLIC_BASE_URL', prev.pinned],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('defaults the filename when none is supplied', async () => {
    await expose({ stream: Readable.from('x') });
    const [, opts] = uploadMock.mock.calls[0];
    expect(opts.filename).toBe('file');
    expect(insertedValues.content_type).toBeNull();
  });

  it('prefers a caller-supplied team over the ambient one', async () => {
    // The WhatsApp door knows whose file this is before it downloads a byte,
    // and saying so must beat whatever identity the process happens to carry.
    await runWithPrincipal(MACHINE, () =>
      exposeFile({ stream: Readable.from('x'), teamId: 'team-explicit' }),
    );
    expect(insertedValues.team_id).toBe('team-explicit');
  });

  it('still writes, untenanted, when there is no team to name', async () => {
    // The regression this pins is a RUN failure, not a missing column. The
    // movement engine establishes no ambient identity — it threads teamId as a
    // parameter — so an adapter exposing a file inside a scheduler-dispatched
    // run has neither a principal nor a team in scope. `exposeFile` was
    // contextless before the tenancy work; a mandatory stamp would not have
    // tenanted these rows, it would have broken the runs that write them.
    await expect(exposeFile({ stream: Readable.from('x') })).resolves.toMatchObject({
      url: expect.stringContaining('/api/files/blob/'),
    });
    expect(insertedValues.team_id).toBeNull();
  });
});
