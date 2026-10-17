// Speech to text behind the model map, bound to the hosted product's
// environment and usage ledger. The vendors live in packages/model-providers.

import type { TranscriptionModelName } from 'movement-engine/public/models';
import type { TranscriptionRequest, TranscriptionResult } from 'model-providers/transcription';

import { transcribe as transcribeWith } from 'model-providers/transcription';
import { hostedModelHost } from '../host';

export function transcribe(
  name: TranscriptionModelName,
  req: TranscriptionRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TranscriptionResult> {
  return transcribeWith(name, req, hostedModelHost(env));
}

export type { TranscriptionRequest, TranscriptionResult };
