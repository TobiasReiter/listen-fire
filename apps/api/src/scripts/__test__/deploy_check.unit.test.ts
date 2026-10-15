// The summary `deploy/up.sh` prints: outcomes by automation name.

jest.mock('../../services', () => ({}));
jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../services/translation_graph/movement/language_upgrade', () => ({
  DEPLOY_CHECK_OUTCOMES: ['advanced', 'current', 'warned', 'refused', 'unverified'],
  latestDeployCheckSummary: jest.fn(),
  liveDeployCheckDeps: jest.fn(),
  runDeployCheck: jest.fn(),
  thisDeployCheckRelease: jest.fn(),
}));

import { renderSummary } from '../deploy_check';

const HERON = { version: 1, name: 'Quiet Heron' };
const OTTER = { version: 2, name: 'Bright Otter' };

describe('renderSummary', () => {
  it('lists advanced, warned and refused automations by name, and counts the already-current', () => {
    const text = renderSummary({
      release: 'v0.8.0',
      languageRelease: 'current=2;supported=1,2;deprecated=',
      current: OTTER,
      ranAt: '2026-09-29T12:00:00.000Z',
      counts: { advanced: 1, current: 2, warned: 1, refused: 0, unverified: 0 },
      automations: [
        { id: 'a', teamId: 't', name: 'Sync CRM', outcome: 'advanced', from: HERON, to: OTTER, deprecated: false, detail: '' },
        { id: 'b', teamId: 't', name: 'Digest', outcome: 'current', from: OTTER, to: OTTER, deprecated: false, detail: '' },
        { id: 'c', teamId: 't', name: 'Other', outcome: 'current', from: OTTER, to: OTTER, deprecated: false, detail: '' },
        { id: 'd', teamId: 't', name: 'Intake', outcome: 'warned', from: HERON, to: HERON, deprecated: false, detail: 'line 3: changed meaning' },
      ],
    });

    expect(text).toContain('Deploy check for release v0.8.0');
    expect(text).toContain('Moved to the current language version: 1');
    expect(text).toContain('- Sync CRM ("Quiet Heron" -> "Bright Otter")');
    expect(text).toContain('Already on the current language version: 2');
    expect(text).not.toContain('Digest');
    expect(text).toContain('- Intake ("Quiet Heron") — line 3: changed meaning');
  });
});
