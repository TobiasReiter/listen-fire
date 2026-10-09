// Public file capability route — `GET /api/files/blob/:id`.
//
// `exposeFile` (engine/files/expose.ts) buffers a FileRef's bytes to S3 under an
// isolated temp prefix and records an `exposed_file` row; the row's unguessable
// id IS the capability. This endpoint looks it up and 302-redirects to a
// presigned S3 URL scoped to the prefix — for targets that need a fetchable URL
// (Airtable, a remote service). No auth header, no credentials in the URL.
//
// Mounted BEFORE the authentication middleware (like the OAuth / webhook-sync
// routes) so it is genuinely public. The id is the authorisation; never logged.

import { Router } from 'express';

import type { Request, Response } from 'express';
import type { ExposedFileId } from '../../generated/kysely/automations/ExposedFile';

import { services } from '../../adapters/registry';
import { getAutomationsQb, getQb } from '../../lib/kysely';
import { EXPOSED_FILE_PREFIX } from '../../services/translation_graph/engine/files/expose';

const filesRouter: ReturnType<typeof Router> = Router();

filesRouter.get('/blob/:id', async (req: Request, res: Response) => {
  const id = req.params.id as ExposedFileId;

  const row = await getAutomationsQb(['exposed_file'])
    .selectFrom('exposed_file')
    .select(['object_uri', 'expires_at'])
    .where('id', '=', id)
    .executeTakeFirst();

  if (!row || row.expires_at.getTime() <= Date.now()) {
    res.status(410).send({ error: 'file_no_longer_available' });
    return;
  }

  // Defence in depth: the public route may only ever sign objects deliberately
  // placed under the isolation prefix.
  if (!objectKey(row.object_uri).startsWith(`${EXPOSED_FILE_PREFIX}/`)) {
    res.status(500).send({ error: 'exposed_file_outside_prefix' });
    return;
  }

  try {
    const signedUrl = await services.document.getDownloadUrl({ objectUri: row.object_uri });
    res.redirect(302, signedUrl);
  } catch {
    res.status(502).send({ error: 'file_resolution_failed' });
  }
});

/** The S3 object key (path after `s3://<bucket>/`). */
function objectKey(objectUri: string): string {
  const withoutScheme = objectUri.replace(/^s3:\/\//, '');
  const slash = withoutScheme.indexOf('/');
  return slash === -1 ? '' : withoutScheme.slice(slash + 1);
}

export { filesRouter };
