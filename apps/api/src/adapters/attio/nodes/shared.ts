import { z } from 'zod';

import { attributeConfigValidator } from '../interface';

export const fieldConfigurationSchema = z.object({
  attribute: attributeConfigValidator,
  prompt: z.string(),
  source: z.enum(['prompt', 'property']).optional(),
  propertyKey: z.string().optional(),
});

export type AttioFieldConfiguration = z.infer<typeof fieldConfigurationSchema>;
