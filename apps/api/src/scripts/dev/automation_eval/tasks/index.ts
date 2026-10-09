import type { Task } from '../task';

import { ambiguousChannel, ambiguousPeople } from './ambiguous';
import { composeAReport } from './compose_a_report';
import { dealflowExtraction } from './dealflow_extraction';
import { declareOnce } from './declare_once';
import { founderAcknowledgement } from './founder_acknowledgement';
import { humanReviewedIntake } from './human_reviewed_intake';
import { inboundIntake } from './inbound_intake';
import { scheduledDigest } from './scheduled_digest';
import { sectionsFromAType } from './sections_from_a_type';

/** The suite, in the order a full run takes them. */
export const TASKS: Task[] = [
  inboundIntake,
  dealflowExtraction,
  composeAReport,
  scheduledDigest,
  sectionsFromAType,
  declareOnce,
  humanReviewedIntake,
  founderAcknowledgement,
  ambiguousChannel,
  ambiguousPeople,
];
