// Config-block union: parse/validate + the value-block subset alias + the
// email forwarding-address block set. Exercises the server-authoritative
// validator (`zodFromConfigBlocks`) and confirms the non-breaking alias
// (`zodFromTriggerConfigFields` delegating) and the email manifest's rich
// trigger-config blocks.

import {
  zodFromConfigBlocks,
  zodFromTriggerConfigFields,
  isValueBlock,
  TRIGGER_SLUG_PATTERN,
  type ConfigBlock,
} from 'movement-engine/services/translation_graph/triggerConfig';
import { EMAIL_MANIFEST } from '../adapters/email';

describe('zodFromConfigBlocks', () => {
  it('builds a validator from value blocks only (section/action skipped)', () => {
    const blocks: ConfigBlock[] = [
      { kind: 'section', tone: 'info', text: 'Framing prose.' },
      { kind: 'slug', key: 'key', label: 'Address', required: true, min: 1, max: 30 },
      { kind: 'action', actionKind: 'demo-picker', label: 'Connect' },
    ];
    const schema = zodFromConfigBlocks(blocks);
    // Only the value block's key is in the validated shape.
    expect(Object.keys(schema.shape)).toEqual(['key']);
  });

  it('enforces the slug charset on slug blocks', () => {
    const schema = zodFromConfigBlocks([
      { kind: 'slug', key: 'key', label: 'Address', required: true },
    ]);
    expect(schema.safeParse({ key: 'good-slug-1' }).success).toBe(true);
    expect(schema.safeParse({ key: 'Bad Slug!' }).success).toBe(false);
  });

  it('rejects an empty required value and honours min/max', () => {
    const schema = zodFromConfigBlocks([
      { kind: 'text', key: 'k', label: 'K', required: true, min: 2, max: 4 },
    ]);
    expect(schema.safeParse({ k: '' }).success).toBe(false);
    expect(schema.safeParse({ k: 'a' }).success).toBe(false);
    expect(schema.safeParse({ k: 'abcde' }).success).toBe(false);
    expect(schema.safeParse({ k: 'abc' }).success).toBe(true);
  });

  it('validates select against its option set', () => {
    const schema = zodFromConfigBlocks([
      {
        kind: 'select',
        key: 'mode',
        label: 'Mode',
        required: true,
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      },
    ]);
    expect(schema.safeParse({ mode: 'a' }).success).toBe(true);
    expect(schema.safeParse({ mode: 'z' }).success).toBe(false);
  });

  it('strips unknown structural keys rather than rejecting', () => {
    const schema = zodFromConfigBlocks([
      { kind: 'slug', key: 'key', label: 'Address', required: true },
    ]);
    const parsed = schema.safeParse({ key: 'abc', destination: { structural: true } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ key: 'abc' });
  });

  it('zodFromTriggerConfigFields delegates (non-breaking alias)', () => {
    const fields = [{ kind: 'slug' as const, key: 'key', label: 'A', required: true }];
    expect(zodFromTriggerConfigFields(fields).safeParse({ key: 'ok' }).success).toBe(true);
    expect(zodFromTriggerConfigFields(fields).safeParse({ key: 'NO' }).success).toBe(false);
  });
});

describe('isValueBlock', () => {
  it('narrows value blocks and excludes presentation/action', () => {
    expect(isValueBlock({ kind: 'text', key: 'k', label: 'K' })).toBe(true);
    expect(isValueBlock({ kind: 'slug', key: 'k', label: 'K' })).toBe(true);
    expect(
      isValueBlock({ kind: 'select', key: 'k', label: 'K', options: [] }),
    ).toBe(true);
    expect(isValueBlock({ kind: 'section', text: 'x' })).toBe(false);
    expect(isValueBlock({ kind: 'action', actionKind: 'p', label: 'L' })).toBe(false);
  });
});

describe('email forwarding-address block set', () => {
  // The address is the DEPLOYMENT's, not a constant — so these fixtures pin
  // one fixed deployment address.
  process.env.INBOUND_EMAIL_ADDRESS = 'inbox@example.com';
  const blocks = EMAIL_MANIFEST.triggerConfig ?? [];

  it('is a section (framing) followed by the routing-key slug block', () => {
    expect(blocks.map((b) => b.kind)).toEqual(['section', 'slug']);
  });

  it('frames the address in plain prose with no internal jargon', () => {
    const section = blocks.find((b) => b.kind === 'section');
    expect(section).toBeDefined();
    if (section && section.kind === 'section') {
      expect(section.text).toMatch(/starts this automation/i);
      expect(section.text).not.toMatch(/routingKey|block|slug|kind/i);
    }
  });

  it('the slug block composes inbox+<key>@example.com and is the routing key', () => {
    const slug = blocks.find((b) => b.kind === 'slug');
    expect(slug).toBeDefined();
    if (slug && (slug.kind === 'slug' || slug.kind === 'text')) {
      expect(slug.key).toBe('key');
      expect(slug.prefix).toBe('inbox+');
      expect(slug.suffix).toBe('@example.com');
      expect(slug.routingKey).toBe(true);
      expect(slug.unique).toBe(true);
      // The composed address with a sample value round-trips the slug charset.
      expect(TRIGGER_SLUG_PATTERN.test('acme-deals')).toBe(true);
    }
  });

  it('says the address is missing rather than inventing one', () => {
    const configured = process.env.INBOUND_EMAIL_ADDRESS;
    delete process.env.INBOUND_EMAIL_ADDRESS;
    try {
      const unconfigured = EMAIL_MANIFEST.triggerConfig ?? [];
      const section = unconfigured.find((b) => b.kind === 'section');
      const slug = unconfigured.find((b) => b.kind === 'slug');
      if (section && section.kind === 'section') {
        expect(section.text).toMatch(/INBOUND_EMAIL_ADDRESS/);
      }
      if (slug && (slug.kind === 'slug' || slug.kind === 'text')) {
        // No prefix at all beats a prefix pointing at somebody else's inbox.
        expect(slug.prefix).toBeUndefined();
        expect(slug.suffix).toBeUndefined();
        expect(slug.routingKey).toBe(true);
      }
      expect(EMAIL_MANIFEST.configurationGap).toMatch(/INBOUND_EMAIL_ADDRESS/);
    } finally {
      process.env.INBOUND_EMAIL_ADDRESS = configured;
    }
  });

  it('reports no configuration gap once the address is set', () => {
    expect(EMAIL_MANIFEST.configurationGap).toBeUndefined();
  });

  it('validates a real inbound key and rejects an invalid one', () => {
    const schema = zodFromConfigBlocks([...blocks]);
    expect(schema.safeParse({ key: 'acme-deals' }).success).toBe(true);
    expect(schema.safeParse({ key: 'Acme Deals' }).success).toBe(false);
    // Required: empty string is rejected.
    expect(schema.safeParse({ key: '' }).success).toBe(false);
  });
});
