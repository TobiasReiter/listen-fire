// The production `files.render` — `FILE(content, "pdf" | "text")` turns a
// composed string into a stored file artifact and answers its descriptor.
//
// Substrate: the Slack v3 output "preview" node's email-body PDF path
// (`knowledge_pipeline/output_v3/adapters/slack.ts` — `renderHtmlToPdf`
// + the `<pre>`-wrapped plain-text fallback of `getEmailBodyHtml`). The
// PDF machinery is the SAME: Playwright Chromium via
// `PlaywrightService.withPage` + `page.pdf` (A4, 16px margins) — no new
// PDF dependency. Playwright is imported lazily inside the pdf branch,
// exactly as slack.ts does, so loading this module costs nothing.
//
// The bytes go straight to the document store and never reach the engine:
// what comes back is a document-store descriptor, durable as it stands, so a
// movement that parks after composing a FILE() resumes holding the same file.
//
// Content is treated as PLAIN TEXT in both renderings: the pdf branch
// escapes it and preserves whitespace (the slack preview's plain-text
// fallback), so what the author composed is what the reader sees —
// predictable over clever.

import { Readable } from 'node:stream';

import type { RenderFile } from 'movement-engine/public/host';
import type { FileRef } from 'movement-engine/public/adapter';

import type { TeamId } from '../../../generated/kysely/core/Team';

import { documentStoreFileRef, teamDocumentKeyPrefix } from 'movement-engine/public/files';

/** The team's `files.render`: its artifacts are stored under the team's key
 *  prefix, which is what makes them the team's to read again. */
export function renderFileArtifactFor(teamId: TeamId): RenderFile {
  return renderInto(teamId);
}

/** A render for no team: its artifacts carry no team's prefix, so only a store
 *  that vouches for its own files (a test's in-memory store) serves them back.
 *  The run host renders with `renderFileArtifactFor`. */
export const renderFileArtifact: RenderFile = renderInto(undefined);

function renderInto(teamId: TeamId | undefined): RenderFile {
  return async (input) => {
    if (input.type === 'text') {
      return storeArtifact({
        teamId,
        name: 'movement-artifact.txt',
        contentType: 'text/plain',
        bytes: Buffer.from(input.content, 'utf8'),
      });
    }
    const bytes = await renderHtmlToPdf(plainTextHtml(input.content));
    return storeArtifact({
      teamId,
      name: 'movement-artifact.pdf',
      contentType: 'application/pdf',
      bytes,
    });
  };
}

async function storeArtifact(options: {
  teamId: TeamId | undefined;
  name: string;
  contentType: string;
  bytes: Buffer;
}): Promise<FileRef> {
  const { teamId, name, contentType, bytes } = options;
  // Lazy import keeps the document-store + registry off this module's eval-time
  // graph (Playwright / dry-run captures load it without an S3 dependency).
  const { services } = await import('../../../adapters/registry');
  const { objectUri } = await services.document.upload(Readable.from(bytes), {
    filename: name,
    mimeType: contentType,
    contentLength: bytes.byteLength,
    ...(teamId !== undefined ? { keyPrefix: teamDocumentKeyPrefix(teamId) } : {}),
  });
  return documentStoreFileRef({ objectUri, name, contentType, size: bytes.byteLength });
}

// ── HTML → PDF (mirrors slack.ts renderHtmlToPdf / getEmailBodyHtml) ─────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function plainTextHtml(content: string): string {
  return `<pre style="font-family: sans-serif; white-space: pre-wrap; word-wrap: break-word;">${escapeHtml(content)}</pre>`;
}

async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const { PlaywrightService } = await import('../../playwright');
  const fullHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 24px; color: #222; background: #fff; font-size: 14px; line-height: 1.5; }
</style></head><body>${html}</body></html>`;

  return PlaywrightService.withPage(async (page) => {
    await page.setContent(fullHtml, { waitUntil: 'domcontentloaded' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '16px', bottom: '16px', left: '16px', right: '16px' },
      printBackground: true,
    });
    return Buffer.from(pdfBuffer);
  });
}
