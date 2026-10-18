// The in-process loop guard (`@lf/fingerprint-guard`) held to the contract
// every loop guard is held to (contract.ts).

import { loopGuardContractCases } from '../contract';
import { FingerprintGuard } from '../loop_guard';

describe('FingerprintGuard', () => {
  for (const contractCase of loopGuardContractCases) {
    it(contractCase.name, () => contractCase.run(new FingerprintGuard()));
  }
});
