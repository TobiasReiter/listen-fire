/**
 * Drain once against the active dev-loop stack — the same entry a scheduled
 * job runs on a real deployment (../drain_once.ts).
 *
 *   pnpm drain:once [--limit <n>] [--max-passes <n>]
 */
import './_profile_loader';
import { drainOnceAndExit } from '../drain_once';

void drainOnceAndExit();
