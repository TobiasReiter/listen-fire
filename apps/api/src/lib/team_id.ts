// A team id arriving as plain text (a request header, an untyped column) — the
// boundary check that names it as one.

import { z } from 'zod';

import type { TeamId } from '../generated/kysely/core/Team';

export const teamIdSchema = z.custom<TeamId>((value) => z.uuid().safeParse(value).success);
