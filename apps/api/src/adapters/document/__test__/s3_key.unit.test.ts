// The S3 store reads one key per URI — every read, delete and ownership
// check goes through `keyOf` — and only a URI of its own bucket whose key's
// segments are each a name.

import { S3Adapter } from '../s3';

const store = new S3Adapter({ bucket: 'docs', region: 'auto', accessKeyId: 'k', secretAccessKey: 's' });

describe('S3Adapter.keyOf', () => {
  it('reads the key of a URI in its own bucket', () => {
    expect(store.keyOf('s3://docs/movement-files/t-1/u/a.pdf')).toBe('movement-files/t-1/u/a.pdf');
  });

  it.each([
    ['another bucket', 's3://other/movement-files/t-1/u/a.pdf'],
    ['a bucket whose name starts with its own', 's3://docsX/u/a.pdf'],
    ['a `..` segment', 's3://docs/movement-files/t-1/../t-2/a.pdf'],
    ['a `.` segment', 's3://docs/movement-files/t-1/./a.pdf'],
    ['an empty segment', 's3://docs/movement-files//t-1/a.pdf'],
    ['a trailing slash', 's3://docs/movement-files/t-1/'],
    ['no key', 's3://docs/'],
    ['another scheme', 'https://docs/u/a.pdf'],
  ])('reads no key for %s', (_what, uri) => {
    expect(store.keyOf(uri)).toBeUndefined();
  });

  it('refuses to read or delete a URI it reads no key for', async () => {
    await expect(store.getFile({ objectUri: 's3://docs/a/../b' })).rejects.toThrow('is not an object of this document store');
    await expect(store.delete('s3://other/a')).rejects.toThrow('is not an object of this document store');
  });
});
