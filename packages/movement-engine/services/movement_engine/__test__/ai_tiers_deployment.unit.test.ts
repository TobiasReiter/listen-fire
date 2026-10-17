import {
  assertExtractionTiersConfigured,
  claudeModelId,
  extractionCallSettings,
  parseExtractionTiers,
} from '../ai_tiers';

const tiers = (entries: Record<string, unknown>) => JSON.stringify(entries);

/**
 * A deployment that sets nothing must call exactly as before deployments could
 * assign tiers: the effort cap on the shallow rows came from production
 * runaways, and the reasoning rows' ceiling from answers that never arrived.
 */
describe('an extraction tier on a deployment that configures nothing', () => {
  const env = {};

  it('buys exactly the built-in table', () => {
    expect(extractionCallSettings({ tier: 'quick', densityModel: 'opus' }, env)).toEqual({
      model: 'sonnet',
      effort: 'low',
    });
    expect(extractionCallSettings({ tier: 'careful', densityModel: 'opus' }, env)).toEqual({
      model: 'sonnet',
      effort: 'high',
      maxTokens: 64_000,
    });
    expect(extractionCallSettings({ tier: 'thorough', densityModel: 'opus' }, env)).toEqual({
      model: 'sonnet',
      effort: 'xhigh',
      maxTokens: 64_000,
    });
    expect(claudeModelId('sonnet')).toBe('claude-sonnet-5');
  });

  it('leaves an untiered extraction to the density heuristic at low effort', () => {
    expect(extractionCallSettings({ tier: undefined, densityModel: 'opus' }, env)).toEqual({
      model: 'opus',
      effort: 'low',
    });
    expect(extractionCallSettings({ tier: undefined, densityModel: 'sonnet' }, env)).toEqual({
      model: 'sonnet',
      effort: 'low',
    });
    expect(claudeModelId('opus')).toBe('claude-opus-4-7');
  });

  it('reads the legacy tier spelling as the tier it means', () => {
    expect(extractionCallSettings({ tier: 'smart', densityModel: 'opus' }, env)).toEqual(
      extractionCallSettings({ tier: 'careful', densityModel: 'opus' }, env),
    );
  });
});

describe('a deployment that assigns its tiers', () => {
  const env = {
    EXTRACTION_TIERS: tiers({ careful: { model: 'claude-opus-5', effort: 'medium' }, quick: { effort: 'medium' } }),
  };

  it('applies the assignment, with the ceiling following the effort', () => {
    expect(extractionCallSettings({ tier: 'careful', densityModel: 'sonnet' }, env)).toEqual({
      model: 'claude-opus-5',
      effort: 'medium',
    });
    expect(claudeModelId('claude-opus-5')).toBe('claude-opus-5');
  });

  it('keeps the built-in value for a field or a tier it leaves out', () => {
    expect(extractionCallSettings({ tier: 'quick', densityModel: 'sonnet' }, env)).toEqual({
      model: 'sonnet',
      effort: 'medium',
    });
    expect(extractionCallSettings({ tier: 'thorough', densityModel: 'sonnet' }, env)).toEqual({
      model: 'sonnet',
      effort: 'xhigh',
      maxTokens: 64_000,
    });
  });

  it('cannot reassign the untiered row', () => {
    expect(extractionCallSettings({ tier: undefined, densityModel: 'opus' }, env)).toEqual({
      model: 'opus',
      effort: 'low',
    });
  });
});

describe("an author's model and effort", () => {
  const env = { EXTRACTION_TIERS: tiers({ careful: { model: 'claude-opus-5', effort: 'medium' } }) };

  it('each win over the tier on their own', () => {
    expect(
      extractionCallSettings({ tier: 'careful', densityModel: 'sonnet', model: 'claude-fable-5-1' }, env),
    ).toEqual({ model: 'claude-fable-5-1', effort: 'medium' });
    expect(extractionCallSettings({ tier: 'careful', densityModel: 'sonnet', effort: 'xhigh' }, env)).toEqual({
      model: 'claude-opus-5',
      effort: 'xhigh',
      maxTokens: 64_000,
    });
  });

  it('take effort from the tier only when none is given, and the ceiling from the effort that results', () => {
    expect(extractionCallSettings({ tier: 'thorough', densityModel: 'sonnet', effort: 'low' }, env)).toEqual({
      model: 'sonnet',
      effort: 'low',
    });
  });

  it('override the density heuristic and the low cap on an untiered extraction', () => {
    expect(
      extractionCallSettings({ tier: undefined, densityModel: 'opus', model: 'claude-sonnet-5', effort: 'high' }, env),
    ).toEqual({ model: 'claude-sonnet-5', effort: 'high', maxTokens: 64_000 });
  });
});

describe('parsing EXTRACTION_TIERS', () => {
  it('reads unset and blank as no assignments', () => {
    expect(parseExtractionTiers(undefined).size).toBe(0);
    expect(parseExtractionTiers('  ').size).toBe(0);
  });

  it('refuses JSON that does not parse', () => {
    expect(() => parseExtractionTiers('{nope')).toThrow(/EXTRACTION_TIERS is not valid JSON/);
  });

  it('refuses a key that is not a tier, naming it', () => {
    expect(() => parseExtractionTiers(tiers({ deep: { effort: 'high' } }))).toThrow(
      /EXTRACTION_TIERS key "deep" is not a tier/,
    );
  });

  it('refuses a misspelt field or an effort outside the four', () => {
    expect(() => parseExtractionTiers(tiers({ careful: { modle: 'claude-opus-5' } }))).toThrow(
      /EXTRACTION_TIERS\["careful"\] must be an object/,
    );
    expect(() => parseExtractionTiers(tiers({ careful: { effort: 'max' } }))).toThrow(
      /EXTRACTION_TIERS\["careful"\] must be an object/,
    );
  });

  it('refuses a model the registry does not know, or one that is not a chat model', () => {
    expect(() => parseExtractionTiers(tiers({ careful: { model: 'claude-sonnet-9' } }))).toThrow(
      /EXTRACTION_TIERS\["careful"\]\.model is "claude-sonnet-9", which is not a model name/,
    );
    expect(() => parseExtractionTiers(tiers({ careful: { model: 'whisper-1' } }))).toThrow(
      /EXTRACTION_TIERS\["careful"\]\.model is "whisper-1", which is not a chat model/,
    );
  });
});

describe('boot validation of EXTRACTION_TIERS', () => {
  const GOOGLE = {
    GOOGLE_PRIVATE_KEY: 'pk',
    GOOGLE_CLIENT_EMAIL: 'robot@example.iam.gserviceaccount.com',
    GOOGLE_PROJECT_ID: 'a-project',
  };

  it('refuses a tier assignment naming a model this deployment cannot reach', () => {
    const env = {
      NODE_ENV: 'production',
      ...GOOGLE,
      MODEL_MAP: JSON.stringify({ 'claude-sonnet-5': 'vertex/claude-sonnet-5' }),
      EXTRACTION_TIERS: tiers({ thorough: { model: 'claude-opus-5' } }),
    };
    expect(() => assertExtractionTiersConfigured(env)).toThrow(
      /EXTRACTION_TIERS\["thorough"\]\.model: "claude-opus-5" goes to anthropic, which has no credentials/,
    );
  });

  it('passes an assignment the map sends somewhere callable', () => {
    const env = {
      NODE_ENV: 'production',
      ...GOOGLE,
      MODEL_MAP: JSON.stringify({ 'claude-opus-5': 'vertex/claude-opus-5' }),
      EXTRACTION_TIERS: tiers({ thorough: { model: 'claude-opus-5' } }),
    };
    expect(() => assertExtractionTiersConfigured(env)).not.toThrow();
  });

  it('passes a deployment that assigns nothing', () => {
    expect(() => assertExtractionTiersConfigured({ NODE_ENV: 'production' })).not.toThrow();
  });
});
