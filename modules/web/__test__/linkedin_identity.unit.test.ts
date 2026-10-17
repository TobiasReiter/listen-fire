import { readTitle } from '../linkedin_identity';

describe('readTitle', () => {
  it('strips a localised suffix: Norwegian', () => {
    const identity = readTitle('Jane Doe - CEO - Acme AS - LinkedIn Norge');
    expect(identity.organisation).toBe('Acme AS');
  });

  it('strips a localised suffix: Spanish', () => {
    const identity = readTitle('Maria Gomez - CEO - Acme SL - LinkedIn España');
    expect(identity.organisation).toBe('Acme SL');
  });

  it('never lets the localised suffix itself become the organisation (regression for the reported bug)', () => {
    const identity = readTitle(
      'Jane Doe – Co-Founder & CEO Acme … - LinkedIn Norge',
    );
    expect(identity.organisation ?? '').not.toMatch(/linkedin/i);
    expect(identity.headline ?? '').not.toMatch(/linkedin/i);
  });

  it('still strips a bare "- LinkedIn" suffix (regression)', () => {
    const identity = readTitle('Jane Doe - Founder - Acme - LinkedIn');
    expect(identity.organisation).toBe('Acme');
  });

  it('strips a suffix joined by an en dash', () => {
    const identity = readTitle('Jane Doe – Founder – Acme – LinkedIn Norge');
    expect(identity.organisation).toBe('Acme');
  });

  it('leaves a title with no LinkedIn suffix untouched', () => {
    const identity = readTitle('Jane Doe - Founder - Acme Corp');
    expect(identity.name).toBe('Jane Doe');
    expect(identity.organisation).toBe('Acme Corp');
  });
});
