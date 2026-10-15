jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { parseAttributeIdFromError } from '../apiClient';

// The two shapes Attio uses to report a rejected field on a 400. The
// retry handler resolves whatever key this returns against the request's
// fields, strips it, and retries — so both formats must be recognised or
// a single bad field fails (and silences) the whole write.
describe('parseAttributeIdFromError', () => {
  function attioError(payload: object): Error {
    return new Error(`Attio Error: 400 (Bad Request): ${JSON.stringify(payload)}`);
  }

  it('extracts the attribute UUID from the message format', () => {
    const err = attioError({
      status_code: 400,
      type: 'invalid_request_error',
      code: 'validation_type',
      message:
        'Invalid value supplied for attribute with ID "a1b2c3d4-0000-0000-0000-000000000000".',
    });
    expect(parseAttributeIdFromError(err)).toBe('a1b2c3d4-0000-0000-0000-000000000000');
  });

  it('extracts the field slug from a records validation_errors path', () => {
    const err = attioError({
      status_code: 400,
      type: 'invalid_request_error',
      code: 'validation_type',
      message: 'Body payload validation error.',
      validation_errors: [{ code: 'invalid', path: ['data', 'values', 'description'], message: 'Invalid input' }],
    });
    expect(parseAttributeIdFromError(err)).toBe('description');
  });

  it('extracts the field slug from a list-entry entry_values path', () => {
    const err = attioError({
      status_code: 400,
      type: 'invalid_request_error',
      code: 'validation_type',
      message: 'Body payload validation error.',
      validation_errors: [{ code: 'invalid', path: ['data', 'entry_values', 'stage'], message: 'Invalid input' }],
    });
    expect(parseAttributeIdFromError(err)).toBe('stage');
  });

  it('returns null for a non-validation Attio error', () => {
    const err = new Error('Attio Error: 401 (Unauthorized): {"status_code":401}');
    expect(parseAttributeIdFromError(err)).toBeNull();
  });

  it('returns null when a 400 carries no recognisable field identifier', () => {
    const err = attioError({
      status_code: 400,
      type: 'invalid_request_error',
      code: 'validation_type',
      message: 'Body payload validation error.',
      validation_errors: [{ code: 'invalid', path: ['data'], message: 'Invalid input' }],
    });
    expect(parseAttributeIdFromError(err)).toBeNull();
  });
});

import { omitNullish } from '../apiClient';

// Movements extract multi-value fields (e.g. companies.domains) from messy
// sources, so arrays routinely arrive with null holes. Attio 400s on a null
// element, and the field-validation retry handler would then strip the WHOLE
// field — so nulls inside arrays must be compacted before the write, without
// disturbing the explicit-[]-means-clear contract.
describe('omitNullish', () => {
  it('drops null and undefined field values, keeps the rest', () => {
    expect(omitNullish({ a: null, b: undefined, c: 'kept', d: 0, e: false })).toEqual({
      c: 'kept',
      d: 0,
      e: false,
    });
  });

  it('strips null/undefined elements from multi-value arrays', () => {
    expect(omitNullish({ domains: ['acme.com', null, undefined, 'acme.io'] })).toEqual({
      domains: ['acme.com', 'acme.io'],
    });
  });

  it('omits an array that held only nulls rather than sending a clear', () => {
    expect(omitNullish({ domains: [null, undefined], name: 'Acme' })).toEqual({ name: 'Acme' });
  });

  it('passes an explicit empty array through (the intentional clear form)', () => {
    expect(omitNullish({ domains: [] })).toEqual({ domains: [] });
  });

  it('leaves non-null array elements untouched, including falsy ones', () => {
    expect(omitNullish({ tags: ['', 0, false] })).toEqual({ tags: ['', 0, false] });
  });
});

import { AttioAPIClient, suffixFileName } from '../apiClient';

// `report.pdf` → `report (1).pdf`, matching the OS/browser-download
// convention — inserted before the FINAL extension, and appended outright
// when there's no real extension to split around.
describe('suffixFileName', () => {
  it('inserts the suffix before the extension', () => {
    expect(suffixFileName('report.pdf', 1)).toBe('report (1).pdf');
  });

  it('increments N for later attempts', () => {
    expect(suffixFileName('report.pdf', 2)).toBe('report (2).pdf');
  });

  it('appends the suffix when the name has no extension', () => {
    expect(suffixFileName('README', 1)).toBe('README (1)');
  });

  it('treats a leading dot as no extension', () => {
    expect(suffixFileName('.env', 1)).toBe('.env (1)');
  });

  it('always derives from the original name (no stacking)', () => {
    // Simulates what the caller does across attempts: re-deriving from
    // `fileName`, never from the previous candidate.
    const fileName = 'archive.tar.gz';
    expect(suffixFileName(fileName, 1)).toBe('archive.tar (1).gz');
    expect(suffixFileName(fileName, 2)).toBe('archive.tar (2).gz');
  });
});

// uploadFile's response to a 409 uniqueness_conflict — Attio scopes file
// names uniquely per record, so a re-run of an already-uploaded movement (or
// two runs racing) collides on the exact same name. The fix lists the
// record's existing files (once) and jumps straight to the lowest free
// `(N)` rather than re-uploading the file's bytes over and over to probe
// names blind.
describe('AttioAPIClient.uploadFile — name-uniqueness conflict retry', () => {
  const fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;

  beforeEach(() => fetchMock.mockReset());

  function conflictResponse(name: string) {
    return new Response(
      JSON.stringify({
        status_code: 409,
        type: 'invalid_request_error',
        code: 'uniqueness_conflict',
        message: `There is already a file with name "${name}".`,
      }),
      { status: 409 },
    );
  }

  function otherConflictResponse() {
    return new Response(
      JSON.stringify({
        status_code: 409,
        type: 'invalid_request_error',
        code: 'some_other_conflict',
        message: 'A different kind of 409 entirely.',
      }),
      { status: 409 },
    );
  }

  function uploadSuccessResponse(name: string) {
    return new Response(
      JSON.stringify({
        data: {
          id: { workspace_id: 'w1', file_id: 'f1' },
          name,
          content_type: 'application/pdf',
          content_size: 100,
        },
      }),
      { status: 200 },
    );
  }

  function listFilesResponse(names: string[]) {
    return new Response(
      JSON.stringify({
        data: names.map((name, i) => ({
          file_type: 'file',
          id: { workspace_id: 'w1', file_id: `existing-${i}` },
          name,
        })),
        pagination: { next_cursor: null },
      }),
      { status: 200 },
    );
  }

  // `formData.append('file', blob, name)` mints a `File` under the hood —
  // this is how each mock attempt learns which candidate name was tried.
  function uploadedNameFrom(init?: RequestInit): string {
    const filePart = (init?.body as FormData).get('file');
    if (!(filePart instanceof File)) {
      throw new Error('expected uploadFile to send a named File part');
    }
    return filePart.name;
  }

  function uploadCalls() {
    return fetchMock.mock.calls.filter(([url]) => (url as URL).pathname === '/v2/files/upload');
  }

  function listCalls() {
    return fetchMock.mock.calls.filter(
      ([url, init]) => (url as URL).pathname === '/v2/files' && (init as RequestInit).method === 'GET',
    );
  }

  it('lists existing files on conflict and uploads under the lowest free suffix', async () => {
    const client = new AttioAPIClient({ accessToken: 'test-token' });
    fetchMock.mockImplementation(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/v2/files' && init?.method === 'GET') {
        return listFilesResponse(['report.pdf', 'report (1).pdf', 'report (2).pdf']);
      }
      if (url.pathname === '/v2/files/upload') {
        const name = uploadedNameFrom(init);
        return name === 'report.pdf' ? conflictResponse(name) : uploadSuccessResponse(name);
      }
      throw new Error(`unexpected request: ${init?.method} ${url.pathname}`);
    });

    const result = await client.uploadFile({
      file: new Blob(['bytes']),
      fileName: 'report.pdf',
      objectSlug: 'companies',
      recordId: 'rec-1',
    });

    expect(result.name).toBe('report (3).pdf');
    expect(uploadCalls()).toHaveLength(2);
    expect(listCalls()).toHaveLength(1);
  });

  it('does not retry a non-uniqueness 409 — rethrows immediately', async () => {
    const client = new AttioAPIClient({ accessToken: 'test-token' });
    fetchMock.mockImplementation(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/v2/files/upload') {
        return otherConflictResponse();
      }
      throw new Error(`unexpected request: ${init?.method} ${url.pathname}`);
    });

    await expect(
      client.uploadFile({
        file: new Blob(['bytes']),
        fileName: 'report.pdf',
        objectSlug: 'companies',
        recordId: 'rec-1',
      }),
    ).rejects.toThrow(/409/);

    expect(uploadCalls()).toHaveLength(1);
    expect(listCalls()).toHaveLength(0);
  });

  it('bumps past a computed name that itself races into a conflict', async () => {
    const client = new AttioAPIClient({ accessToken: 'test-token' });
    fetchMock.mockImplementation(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/v2/files' && init?.method === 'GET') {
        // Nothing suffixed exists yet, so the computed candidate is `(1)` —
        // but a concurrent upload lands it first.
        return listFilesResponse(['report.pdf']);
      }
      if (url.pathname === '/v2/files/upload') {
        const name = uploadedNameFrom(init);
        return name === 'report.pdf' || name === 'report (1).pdf'
          ? conflictResponse(name)
          : uploadSuccessResponse(name);
      }
      throw new Error(`unexpected request: ${init?.method} ${url.pathname}`);
    });

    const result = await client.uploadFile({
      file: new Blob(['bytes']),
      fileName: 'report.pdf',
      objectSlug: 'companies',
      recordId: 'rec-1',
    });

    expect(result.name).toBe('report (2).pdf');
    expect(uploadCalls()).toHaveLength(3);
    // The race backstop bumps N without re-listing.
    expect(listCalls()).toHaveLength(1);
  });

  it('caps at 5 total upload attempts and rethrows the last 409', async () => {
    const client = new AttioAPIClient({ accessToken: 'test-token' });
    fetchMock.mockImplementation(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/v2/files' && init?.method === 'GET') {
        return listFilesResponse([]);
      }
      if (url.pathname === '/v2/files/upload') {
        return conflictResponse(uploadedNameFrom(init));
      }
      throw new Error(`unexpected request: ${init?.method} ${url.pathname}`);
    });

    await expect(
      client.uploadFile({
        file: new Blob(['bytes']),
        fileName: 'report.pdf',
        objectSlug: 'companies',
        recordId: 'rec-1',
      }),
    ).rejects.toThrow(/409/);

    expect(uploadCalls()).toHaveLength(5);
    expect(listCalls()).toHaveLength(1);
  });
});
