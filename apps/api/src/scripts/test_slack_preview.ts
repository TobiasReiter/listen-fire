/**
 * Quick test script for Slack email preview rendering.
 *
 * Usage:
 *   CREDENTIAL_ID=<uuid> SLACK_CHANNEL=C... npx tsx apps/api/src/scripts/test_slack_preview.ts
 */

import type { MessageAttachment } from '@slack/web-api';
import type { ExternalServiceCredentialsId } from '../generated/kysely/automations/ExternalServiceCredentials';

import { getAutomationsQb } from '../lib/kysely';
import { decryptToken } from '../lib/credentials';
import { getSlackClient, slackCredsParser } from '../adapters/slack/webApi/apiClient';

// ── Config ──────────────────────────────────────────────────────────────

const credentialId = process.env.CREDENTIAL_ID as ExternalServiceCredentialsId | undefined;
const channelId = process.env.SLACK_CHANNEL;

if (!credentialId || !channelId) {
  console.error('Required env vars: CREDENTIAL_ID, SLACK_CHANNEL');
  process.exit(1);
}

// ── Fake email payload ──────────────────────────────────────────────────

const fakePayload = {
  subject: 'Fwd: Alice Chen (Northlight) <-> Bob Marsh (Tidepool)',
  sender: 'Jane Rivera <jane@example.com>',
  To: 'team@example.com, deals@example.com',
  Cc: 'ops@example.com',
  'body-html': `
    <div style="font-family: Arial, sans-serif; color: #333;">
      <p>Team,</p>
      <p>This one caught my eye — Bob has been building a developer productivity tool
      that automates code review workflows. They hit 200k monthly active developers
      last quarter and retention numbers look strong. Previously he was a staff engineer
      at a large infra company, so the technical depth is real.</p>
      <p>Worth a first call?</p>
      <hr>
      <p style="color: #888;">---------- Forwarded message ----------<br>
      From: Jane Rivera &lt;jane@example.com&gt;<br>
      Date: Mon, Mar 23, 2026 at 10:15 AM<br>
      Subject: Alice Chen (Northlight) &lt;-&gt; Bob Marsh (Tidepool)<br>
      To: Alice Chen &lt;alice@northlight.vc&gt;, Bob Marsh &lt;bob@tidepool.dev&gt;</p>
      <p>Alice, Bob — connecting you as discussed.</p>
      <p>Alice — Bob is the founder and CEO of Tidepool, a developer tools company
      focused on AI-assisted code review. They recently crossed 200k MAUs and are
      exploring Series A options.</p>
      <p>Bob — Alice is a partner at Northlight Ventures, one of the leading deep-tech
      funds in Europe. She previously led infrastructure investments at a top-tier firm.</p>
      <p>I'll leave you both to find a time.</p>
      <p>Best,<br>Jane</p>
    </div>
  `,
};

const fakeMetadata: Record<string, unknown> = {
  payloadChannel: 'MAILGUN',
  subject: fakePayload.subject,
  from_address: 'jane@example.com',
  to_address: 'team@example.com, deals@example.com',
};

// ── Helpers (duplicated from slack adapter since they're not exported) ───

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildEmailHeaderBlocks(
  payload: Record<string, unknown>,
  metadata: Record<string, unknown>,
) {
  const subject = (payload.subject ?? metadata.subject ?? 'No subject') as string;
  const sender = (payload.sender ?? payload['X-Original-From'] ?? metadata.from_address ?? '') as string;
  const to = (payload.To ?? metadata.to_address ?? payload.recipient ?? '') as string;
  const cc = (payload.Cc ?? '') as string;

  const headerFields: string[] = [];
  if (sender) headerFields.push(`*From:*  ${sender}`);
  if (to) headerFields.push(`*To:*  ${to}`);
  if (cc) headerFields.push(`*Cc:*  ${cc}`);

  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: subject.slice(0, 150), emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: headerFields.join('\n') },
    },
  ];

  return { blocks, text: `${subject} — from ${sender}`, subject };
}

function getEmailBodyHtml(payload: Record<string, unknown>): string {
  const bodyHtml = payload['body-html'] as string | undefined;
  if (bodyHtml) return bodyHtml;

  const bodyPlain = (payload['body-plain'] ?? payload['stripped-text']) as string | undefined;
  if (bodyPlain) {
    return `<pre style="font-family: sans-serif; white-space: pre-wrap;">${escapeHtml(bodyPlain)}</pre>`;
  }

  return '<p style="color: #999;">No body content</p>';
}

async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const { PlaywrightService } = await import('../services/playwright');
  const fullHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 24px; color: #222; background: #fff; font-size: 14px; line-height: 1.5; }
</style></head><body>${html}</body></html>`;

  return PlaywrightService.withPage(async (page) => {
    await page.setContent(fullHtml, { waitUntil: 'networkidle' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '16px', bottom: '16px', left: '16px', right: '16px' },
      printBackground: true,
    });
    return Buffer.from(pdfBuffer);
  });
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  // Load and decrypt credential from DB
  console.log('Loading credential...');
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', credentialId!)
    .select(['id', 'credentials'])
    .executeTakeFirstOrThrow();

  const decrypted = await decryptToken(row.credentials, row.id);
  const parsed = slackCredsParser.parse(JSON.parse(decrypted));
  const client = getSlackClient(parsed.accessToken, parsed.baseUrl);

  // 1. Post header blocks
  const { blocks, text, subject } = buildEmailHeaderBlocks(fakePayload, fakeMetadata);

  console.log('Posting header message...');
  const headerResult = await client.api.chat.postMessage({
    channel: channelId!,
    text,
    attachments: [{ color: '#2EB67D', blocks }] as unknown as MessageAttachment[],
    unfurl_links: false,
    unfurl_media: false,
  });

  if (!headerResult.ok || !headerResult.ts) {
    console.error('Failed to post header:', headerResult.error);
    process.exit(1);
  }
  console.log('Header posted:', headerResult.ts);

  // 2. Render body to PDF and upload
  const bodyHtml = getEmailBodyHtml(fakePayload);
  console.log('Rendering PDF via Playwright...');
  const pdfBuffer = await renderHtmlToPdf(bodyHtml);
  console.log(`PDF rendered: ${pdfBuffer.byteLength} bytes`);

  const uploadUrl = await client.api.files.getUploadURLExternal({
    filename: `${subject}.pdf`,
    length: pdfBuffer.byteLength,
  });

  if (!uploadUrl?.upload_url || !uploadUrl?.file_id) {
    console.error('Failed to get upload URL:', uploadUrl.error);
    process.exit(1);
  }

  await client.fetch(uploadUrl.upload_url, {
    method: 'POST',
    body: pdfBuffer,
    headers: { 'Content-Type': 'application/pdf' },
  } as RequestInit);

  await client.api.files.completeUploadExternal({
    channel_id: channelId!,
    thread_ts: headerResult.ts,
    files: [{ id: uploadUrl.file_id, title: subject }],
  });

  console.log('PDF uploaded as reply. Done!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
