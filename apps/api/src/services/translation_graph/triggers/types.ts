// Trigger taxonomy and event shape (P6). The event is the run's input, so it
// is the contract's (`engine-contracts`); this module is where the run host's
// code has always found it.

export {
  inboundRecordRefSchema,
  triggerEventSchema,
  triggerTypeSchema,
  type InboundRecordRef,
  type TriggerEvent,
  type TriggerType,
} from 'engine-contracts';
