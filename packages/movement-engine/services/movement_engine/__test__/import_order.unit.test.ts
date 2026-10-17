// The evaluator's module, loaded before anything else of the engine's, must
// load without loading run.ts: it imports the Rust shim, and a cycle back
// through run.ts once read a binding of the evaluator's module before that
// module had run (`Bound`, in its temporal dead zone). The shim takes what it
// needs of a run's failure from errors.ts, so the cycle is gone at its
// source, not merely survived.

describe('the engine modules', () => {
  it('load with the evaluator first, and the evaluator never loads run.ts', () => {
    jest.isolateModules(() => {
      jest.doMock('../run', () => {
        throw new Error('run.ts was loaded on the evaluator’s import path');
      });
      expect(() => require('../expression')).not.toThrow();
    });
    jest.dontMock('movement-engine/services/movement_engine/run');
  });

  it('load with the evaluator first, run.ts included', () => {
    jest.isolateModules(() => {
      expect(() => require('../expression')).not.toThrow();
      expect(() => require('../run')).not.toThrow();
    });
  });
});
