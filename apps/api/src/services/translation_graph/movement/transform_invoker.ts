// The production `through` / plugin-call invoker a movement run's host hands
// the engine: the TG transform registry, and the document store a plugin's
// fetched files land in.

import { runFields } from '../../../lib/llm_usage';
import { isRunCostCapExceeded } from '../../../lib/run_spend';
import { DocumentService } from '../../document';
import { logger } from '../../logger';
import {
  transformFor,
  type MovementTransformInvoker,
  type TransformInvocationResult,
} from '../../movement_engine/extraction';
import type { FileRef } from '../adapter';
import { documentStoreFileRef } from '../engine/files/document_store';
import type { TransformInput, TransformOutput } from '../engine/transforms/registry';
import { makeEphemeralPosition, type TransformOutputShape } from '../types';

/**
 * The production invoker — the TG transform registry, dispatched the same way
 * the TG engine's enrichment cycle dispatches transforms
 * (`kind: 'context-dependent'`, structural `properties` projected into
 * the context data block). Movement identifiers can't carry dashes, so
 * the underscore spelling resolves too (`vc_url_retrieval`).
 */
export const registryTransformInvoker: MovementTransformInvoker = {
  declaredOutput(plugin): TransformOutputShape | undefined {
    return transformFor(plugin)?.signature.output;
  },
  isPriced(plugin): boolean {
    return transformFor(plugin)?.priced === true;
  },
  async invoke({ plugin, config, extractedContext }): Promise<TransformInvocationResult> {
    const impl = transformFor(plugin);
    if (!impl) {
      logger.warn('[movement:transform] no such plugin — skipping', { plugin, ...runFields() });
      return {};
    }

    const sourceNode = makeEphemeralPosition({
      data: {},
      originRef: {
        kind: 'transform',
        transformName: plugin,
        emissionIndex: 0,
        nodeId: 'movement-through-synthetic',
      },
    });

    // Dispatch the timing variant the plugin declares. A pre-extraction
    // plugin (dataDependency 'none', e.g. vc_url_retrieval) enriches the
    // source and rejects a context-dependent input; an extracted-context
    // plugin (e.g. linkedin_enrichment) reads the entity's fields so far.
    const input: TransformInput =
      impl.signature.dataDependency === 'none'
        ? { kind: 'pre-extraction', sourceNode, config }
        : { kind: 'context-dependent', sourceNode, config, extractedContext };

    let result: TransformOutput;
    try {
      result = await impl.run(input);
    } catch (error) {
      // Out of money is not "no enrichment": the run stops, as it would at a
      // model call made outside a plugin.
      if (isRunCostCapExceeded(error)) throw error;
      logger.warn('[movement:transform] plugin threw — no enrichment', {
        plugin,
        error,
        ...runFields(),
      });
      return {};
    }

    // Two ways a plugin's output reaches the following extraction: a
    // pre-extraction plugin carries the content it fetched on its edge
    // emissions' `text` (feeds the extractor as fresh source), and an
    // extracted-context plugin adds `properties` the next stage can read.
    const data: Record<string, unknown> = { ...(result.properties ?? {}) };
    const fetchedText = collectEmissionText(result.edges);
    const records = await emissionRecords(result.edges, plugin);

    const out: TransformInvocationResult = {};
    if (fetchedText) out.text = fetchedText;
    if (Object.keys(data).length > 0) out.data = data;
    if (records.length > 0) out.records = records;
    if (result.outcome) out.outcome = result.outcome;
    if (result.cost !== undefined) out.cost = result.cost;

    logger.info('[movement:transform] ran', {
      plugin,
      addedFields: Object.keys(data),
      fetchedChars: fetchedText?.length ?? 0,
      ...(result.outcome ? { outcome: result.outcome } : {}),
      ...runFields(),
    });

    return out;
  },
};

/** Pull the fetched text off a pre-extraction plugin's edge emissions
 *  (vc_url_retrieval's `vcUrl` records carry each fetched page's content
 *  on `text`) so it can feed the extraction that follows. */
function collectEmissionText(edges: TransformOutput['edges']): string | undefined {
  if (!edges) return undefined;
  const chunks: string[] = [];
  for (const emissions of Object.values(edges)) {
    for (const emission of Array.isArray(emissions) ? emissions : [emissions]) {
      const text = (emission.data as { text?: unknown } | null)?.text;
      if (typeof text === 'string' && text.trim()) chunks.push(text);
    }
  }
  return chunks.length > 0 ? chunks.join('\n\n') : undefined;
}

/**
 * A pre-extraction plugin's edge emissions as records, one per emission, in the
 * order emitted. A fetch that stored a document emits the document's id on
 * `file` — a storage detail no author can do anything with — so it is swapped
 * here for the file value itself, the same document-store file a `FILE()`
 * render produces. One lookup per invocation, however many documents it
 * stored.
 *
 * A document that can no longer be found drops the `file` and keeps the rest:
 * the page's text still reached the extraction, and the record says what it
 * can.
 */
async function emissionRecords(
  edges: TransformOutput['edges'],
  plugin: string,
): Promise<Array<Record<string, unknown>>> {
  if (!edges) return [];
  const emitted: Array<Record<string, unknown>> = [];
  for (const emissions of Object.values(edges)) {
    for (const emission of Array.isArray(emissions) ? emissions : [emissions]) {
      if (emission.data !== null && typeof emission.data === 'object') {
        emitted.push({ ...(emission.data as Record<string, unknown>) });
      }
    }
  }
  const documentIds = [
    ...new Set(emitted.flatMap((r) => (typeof r.file === 'string' ? [r.file] : []))),
  ];
  const files = await storedDocumentFiles(documentIds, plugin);
  return emitted.map((record) => {
    const { file, ...rest } = record;
    const ref = typeof file === 'string' ? files.get(file) : undefined;
    return ref !== undefined ? { ...rest, file: ref } : rest;
  });
}

/** Stored documents by id, as file values. The loads go through the document
 *  service's batching loader, so several ids are one query. */
async function storedDocumentFiles(ids: string[], plugin: string): Promise<Map<string, FileRef>> {
  const files = new Map<string, FileRef>();
  if (ids.length === 0) return files;
  const loaded = await Promise.allSettled(ids.map((id) => DocumentService.getById(id)));
  loaded.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      files.set(
        ids[i],
        documentStoreFileRef({ objectUri: result.value.objectUri, name: result.value.description }),
      );
    } else {
      logger.warn('[movement:transform] stored document not found — its file is dropped', {
        plugin,
        documentId: ids[i],
        error: result.reason,
        ...runFields(),
      });
    }
  });
  return files;
}
