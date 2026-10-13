import { aiExpressionSettings, extractionSettings } from '../ai_tiers';

/**
 * What a tier BUYS. The numbers here are the platform's side of the line, so a
 * change to one is a deliberate retune rather than a refactor — pinning them is
 * how a silent drift in what an author paid for gets caught.
 *
 * `thorough`'s ceiling is the one with a production incident behind it: the
 * adaptive-thinking models spend their reasoning from the same `max_tokens` as
 * their answer, so a ceiling that fits the answer alone can be exhausted before
 * a single character of it is written.
 */
describe('what an extraction tier asks the platform for', () => {
  // The ceiling follows the DEPTH, not the tier's name. Both rows that reason
  // get it: `careful` failed in production exactly as `thorough` did — a whole
  // 32k ceiling spent thinking, no answer written — and the stage it failed on
  // needs 22.5k for the answer alone.
  it('gives both reasoning tiers room for their thinking AND their answer', () => {
    expect(extractionSettings('careful', 'sonnet')).toEqual({
      model: 'sonnet',
      effort: 'high',
      maxTokens: 64_000,
    });
    expect(extractionSettings('thorough', 'sonnet')).toEqual({
      model: 'sonnet',
      effort: 'xhigh',
      maxTokens: 64_000,
    });
  });

  // Naming no ceiling is not the same as naming 32000: it leaves the client's
  // own standing, which is the flat 32k — or the input-sized budget where the
  // guard is switched on. A shallow call's ceiling only has to fit its answer.
  it('leaves a shallow tier on the client’s own ceiling', () => {
    expect(extractionSettings('quick', 'sonnet')).toEqual({ model: 'sonnet', effort: 'low' });
  });

  // An untiered extraction is exactly what it was before tiers existed: the
  // density heuristic's model, shallow effort, the input-sized ceiling.
  it('leaves an untiered extraction to the density heuristic', () => {
    expect(extractionSettings(undefined, 'opus')).toEqual({ model: 'opus', effort: 'low' });
  });
});

describe('what an AI() tier asks the platform for', () => {
  it('gives the deepest tier the same headroom the extraction row gets', () => {
    expect(aiExpressionSettings('thorough')).toEqual({ model: 'opus5', maxTokens: 64_000 });
  });

  it('leaves the shallower rows alone', () => {
    expect(aiExpressionSettings('careful')).toEqual({ model: 'sonnet' });
    expect(aiExpressionSettings('quick')).toEqual({ model: 'haiku', effort: 'low' });
    expect(aiExpressionSettings(undefined)).toEqual({ model: 'haiku', effort: 'low' });
  });
});
