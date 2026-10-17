// Public, unauthenticated integrations surface for the marketing landing page.
//
//   GET  /api/public/integrations          → the OOTB integrations grid
//   POST /api/public/integrations/suggest   → record a "request an integration"
//
// The grid is derived ENTIRELY from the static adapter manifests
// (`listAdapterManifests()`), so it self-maintains as adapters land — there is
// no hand-kept list to rot. We exclude internal plumbing that isn't a
// third-party system a visitor would recognise (Run now, Schedule, the
// intrinsic knowledge graph, the Pipedrive stub).
//
// The suggestion endpoint persists a demand signal (`integration_suggestion`),
// surfaced to ops via the admin/DB. Mounted on the public router (no auth).

import { z } from 'zod';
import { RequestHandler } from 'express';

import { getQb } from '../../lib/kysely';
import {
  getBrandIcon,
  listAdapterManifests,
} from '../../services/translation_graph/adapters/registry';
import {
  WRITE_METHODS,
  type BrandIcon,
  type IntegrationCategory,
} from 'movement-engine/public/adapter';
import { sendSlackNotification } from '../../lib/slack';
import { logger } from 'movement-engine/public/log';

/** Methods that let a movement read data back out of a system. */
const READ_METHODS = ['readRecord', 'getFieldValue', 'getRelated'] as const;

/**
 * Adapter slugs that are internal plumbing, not third-party integrations a
 * visitor would picture on a "works with your stack" grid. Everything else in
 * the manifest registry shows up automatically.
 */
const HIDDEN_FROM_GRID = new Set([
  'manual',
  'cron',
  'system',
  'kg',
  'native-valuations',
]);

export type PublicIntegration = {
  slug: string;
  name: string;
  description: string;
  reads: boolean;
  writes: boolean;
  listensForEvents: boolean;
  website?: string;
  category?: IntegrationCategory;
  icon?: BrandIcon;
};

const listIntegrationsHandler: RequestHandler = (_req, res) => {
  const integrations: PublicIntegration[] = listAdapterManifests()
    .filter((m) => !HIDDEN_FROM_GRID.has(m.adapterType))
    .map((m) => ({
      slug: m.adapterType,
      name: m.displayName,
      description: m.description ?? '',
      reads: m.methods.some((x) => (READ_METHODS as readonly string[]).includes(x)),
      writes: m.methods.some((x) => (WRITE_METHODS as readonly string[]).includes(x)),
      listensForEvents: m.supportedTriggers.length > 0,
      website: m.website,
      category: m.category,
      icon: getBrandIcon(m.adapterType) ?? undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.status(200).send({ integrations });
};

const suggestIntegrationSchema = z.object({
  toolName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).optional().or(z.literal('')),
  note: z.string().trim().max(2000).optional(),
});

const suggestIntegrationHandler: RequestHandler = async (req, res) => {
  const parsed = suggestIntegrationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).send({ error: 'invalid_suggestion' });
    return;
  }
  const { toolName, email, note } = parsed.data;

  try {
    await getQb(['integration_suggestion'])
      .insertInto('integration_suggestion')
      .values({
        tool_name: toolName,
        email: email ? email : null,
        note: note ?? null,
      })
      .execute();

    const who = email ? ` (from ${email})` : '';
    const extra = note ? `\n> ${note}` : '';
    void sendSlackNotification({
      type: 'SUPPORT',
      text: `🧩 Integration requested: *${toolName}*${who}${extra}`,
      opsTitle: `Integration requested: ${toolName}`,
    }).catch((e) =>
      logger.warn('integration suggestion slack notify failed', { error: e }),
    );

    res.status(201).send({ ok: true });
  } catch (err) {
    console.error('integration suggestion failed', err);
    res.status(500).send({ error: 'could_not_record_suggestion' });
  }
};

export { listIntegrationsHandler, suggestIntegrationHandler };
