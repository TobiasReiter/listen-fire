// The engine package's public entries: each one loads (no import cycle breaks
// at load), carries the answers its comment promises, and the injectable
// logger takes the engine's log lines and gives the console back.

import * as engine from '../../../public/movement-engine';
import * as host from '../../../public/host';
import * as runHost from '../../../public/run-host';
import * as adapter from '../../../public/adapter';
import * as catalog from '../../../public/catalog';
import * as inbound from '../../../public/inbound';
import * as secrets from '../../../public/secrets';
import * as plugins from '../../../public/plugins';
import * as models from '../../../public/models';
import * as files from '../../../public/files';
import * as testing from '../../../public/testing';
import * as types from '../../../public/types';
import * as errors from '../../../public/errors';
import * as json from '../../../public/json';
import * as queue from '../../../public/queue';
import * as text from '../../../public/text';
import * as addresses from '../../../public/addresses';
import * as bootChecks from '../../../public/boot-checks';
import * as trace from '../../../public/trace';
import * as embed from '../../../public/embed';
import { logger, routeEngineLogsTo, type EngineLogSink } from '../../../public/log';

describe('public entries', () => {
  it('the engine entry runs, resumes, checks and routes', () => {
    expect(typeof engine.runMovement).toBe('function');
    expect(typeof engine.resumeMovement).toBe('function');
    expect(typeof engine.checkPinned).toBe('function');
    expect(typeof engine.programCheck.checkPinned).toBe('function');
    expect(engine.engineRoute({ languageVersion: 5 })).toBe('rust');
    expect(engine.engineRoute({ languageVersion: 4 })).toBe('ts');
    expect(engine.ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the other entries carry their families', () => {
    expect(Object.keys(host.HOST_FAMILIES).length).toBeGreaterThan(0);
    expect(typeof host.adapterTable).toBe('function');
    expect(typeof runHost.drainRun).toBe('function');
    expect(typeof adapter.normalizeAdapterType).toBe('function');
    expect(typeof catalog.buildCatalogSnapshot).toBe('function');
    expect(typeof inbound.verifyRemoteSignature).toBe('function');
    expect(typeof inbound.receiveDelivery).toBe('function');
    expect(typeof secrets.createSecretsFamily).toBe('function');
    expect(Object.keys(plugins.bundledPluginSpecs()).length).toBeGreaterThan(0);
    expect(typeof models.resolveModel).toBe('function');
    expect(typeof files.redeemFileRef).toBe('function');
    expect(typeof testing.makeTestHost).toBe('function');
  });

  it('each concept entry carries its concept', () => {
    expect(typeof types.neverAsAny).toBe('function');
    expect(new errors.MovementEngineError('MOVENG_RUNTIME', 'x').code).toBe('MOVENG_RUNTIME');
    expect(errors.getErrorMessage(new Error('boom'))).toBe('boom');
    expect(json.parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(typeof queue.Queue).toBe('function');
    expect(text.slugify('Acme Corp')).toBe('acme-corp');
    expect(addresses.encodeAddress(addresses.parseAddress('s1.b0'))).toBe('s1.b0');
    expect(typeof bootChecks.assertSegmentLimitsConfigured).toBe('function');
    expect(typeof trace.isWriteEffect).toBe('function');
    expect(typeof host.segmentScopedCalls.around).toBe('function');
    expect(typeof inbound.collectFileListeners).toBe('function');
    expect(typeof inbound.answerModels).toBe('function');
    expect(typeof engine.listUnsupportedConstructs).toBe('function');
    expect(engine.RUST_ENGINE_FROM_VERSION).toBe(5);
    expect(Object.keys(models.embeddingDestinations).length).toBeGreaterThan(0);
    expect(typeof embed.memoryRunHostStore).toBe('function');
  });
});

describe('routeEngineLogsTo', () => {
  it('takes the lines, then restores the console transport', () => {
    const lines: Parameters<EngineLogSink>[0][] = [];
    const before = logger.transports.length;
    const restore = routeEngineLogsTo((line) => lines.push(line));
    logger.warn('careful', { run: 'r1' });
    logger.info('fine');
    restore();
    expect(lines.map((l) => [l.level, l.message])).toEqual([
      ['warn', 'careful'],
      ['info', 'fine'],
    ]);
    expect(lines[0].meta).toMatchObject({ run: 'r1' });
    expect(logger.transports.length).toBe(before);
  });
});
