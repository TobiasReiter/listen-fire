import { Writable } from 'node:stream';

import { Request, RequestHandler } from 'express';

import { DocumentService } from '../../services/document';
import { getIconForUrl } from '../../services/icons';
import { extractDistinctQueryParams } from './utils';
import { services } from '../../adapters/registry';
import { logger } from 'movement-engine/services/logger';
import { verifyDocumentSignature } from '../../lib/document_link';

const iconHandler: RequestHandler = async (req, res) => {
  const query = extractDistinctQueryParams(req, ['size', 'hostname']);
  try {
    const iconResponse = await getIconForUrl(query.hostname, query.size);
    if (iconResponse) {
      return iconResponse.pipe(res);
    }
  } catch (err) {
    console.error(err);
  }

  return res.sendStatus(404);
};

/** The single query param, when it is present exactly once. */
const optionalParam = (req: Request, key: string): string | undefined => {
  const value = req.query[key];
  return typeof value === 'string' ? value : undefined;
};

/**
 * Serve a document's bytes to whoever holds a SIGNED link. The signature is the
 * authorisation — the id alone never was one (see `lib/document_link`) — and a
 * bad signature answers exactly what a nonexistent document answers, so a probe
 * learns nothing from the difference.
 */
const documentDownloadHandler: RequestHandler = async (req, res) => {
  const id = req.params.id;
  if (
    !verifyDocumentSignature({
      documentId: id,
      sig: optionalParam(req, 'sig'),
      exp: optionalParam(req, 'exp'),
    })
  ) {
    return res.sendStatus(404);
  }

  try {
    const doc = await DocumentService.dataloaders.findById.load(id);
    if (!doc) return res.sendStatus(404);

    const rs = await services.document.getFile(doc);

    if (req.query.filename) {
      res.setHeader('Content-Disposition', `inline; filename="${req.query.filename}"`);
    }
    const webstream = await rs?.webStream?.pipeTo(Writable.toWeb(res));
    return res.status(200).send(webstream);
  } catch (err) {
    // The error stays server-side: it names storage keys and internals to a
    // caller we know nothing about beyond their holding a valid link.
    logger.error('[public/document] could not serve document', { documentId: id, err });
    return res.status(500).send({ error: 'document_unavailable' });
  }
};

const getFeatureFlags: RequestHandler = async (_req, res) => {
  return res.status(200).send({});
};

export {
  iconHandler,
  documentDownloadHandler,
  getFeatureFlags,
};
