// The secrets family's contract suite (packages/movement-engine/services/
// secrets/contract.ts) against the in-memory vault an embedder starts from.

import { randomUUID } from 'node:crypto';
import { createMemoryVault } from 'movement-engine/public/secrets';
import { secretsContractCases } from 'movement-engine/public/secrets-testing';

describe('secrets contract: in-memory vault', () => {
  for (const contractCase of secretsContractCases) {
    it(contractCase.name, async () => {
      const vault = createMemoryVault();
      await contractCase.run({
        backend: vault,
        // One vault object is one store; a second family over it is the
        // second process.
        sibling: () => vault,
        seed: async (fields) => {
          const ref = randomUUID();
          vault.put(ref, fields);
          return ref;
        },
        missingRef: () => randomUUID(),
      });
    });
  }
});
