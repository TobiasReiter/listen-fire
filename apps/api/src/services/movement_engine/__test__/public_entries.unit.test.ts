// The engine package's public entries: each one loads (no import cycle breaks
// at load), carries the answers its comment promises, and the injectable
// logger takes the engine's log lines and gives the console back.

import * as engine from 'movement-engine/public/movement-engine';
import * as host from 'movement-engine/public/host';
import * as runHost from 'movement-engine/public/run-host';
import * as adapter from 'movement-engine/public/adapter';
import * as catalog from 'movement-engine/public/catalog';
import * as inbound from 'movement-engine/public/inbound';
import * as secrets from 'movement-engine/public/secrets';
import * as models from 'movement-engine/public/models';
import * as files from 'movement-engine/public/files';
import * as testing from 'movement-engine/public/testing';
import { logger, routeEngineLogsTo, type EngineLogSink } from 'movement-engine/public/log';

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
    expect(Object.keys(secrets)).toEqual([]);
    expect(typeof models.resolveModel).toBe('function');
    expect(typeof files.redeemFileRef).toBe('function');
    expect(typeof testing.makeTestHost).toBe('function');
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
