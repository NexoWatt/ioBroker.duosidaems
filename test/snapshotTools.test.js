'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanSnapshot,
  computeDerivedPower,
  normalizePhaseCount,
  roundNumber,
} = require('../lib/snapshotTools');

test('normalizePhaseCount keeps only 1 or 3 phases', () => {
  assert.equal(normalizePhaseCount(1), 1);
  assert.equal(normalizePhaseCount(3), 3);
  assert.equal(normalizePhaseCount(2), 3);
  assert.equal(normalizePhaseCount(null), 3);
});

test('roundNumber rounds to two decimals', () => {
  assert.equal(roundNumber(6.239, 2), 6.24);
  assert.equal(roundNumber(null, 2), null);
});

test('computeDerivedPower prefers calculated power for local transport', () => {
  const power = computeDerivedPower({
    transport: 'local',
    voltage: 234.27,
    current: 6.23,
    configuredCurrent: 6,
    explicitPower: 1.039,
    phaseCount: 3,
    isCharging: true,
  });

  assert.equal(Math.round(power * 100) / 100, 4216.86);
});

test('cleanSnapshot rounds values and sanitizes long session timestamps', () => {
  const cleaned = cleanSnapshot({
    transport: 'local',
    isCharging: true,
    voltage: 234.2764893,
    current: 6.23299026,
    power: 1.0390625,
    sessionStartTsMs: Date.UTC(2025, 10, 17),
    sessionDurationMin: 161077,
    maxCurrent: null,
  }, {
    phaseCount: 3,
    shadowMaxCurrent: 6,
    nowMs: Date.UTC(2026, 2, 9),
  });

  assert.equal(cleaned.voltage, 234.28);
  assert.equal(cleaned.current, 6.23);
  assert.equal(cleaned.maxCurrent, 6);
  assert.equal(cleaned.power, 4217);
  assert.equal(cleaned.sessionStartTsMs, null);
  assert.equal(cleaned.sessionDurationMin, null);
});

test('cleanSnapshot keeps zero power when not charging', () => {
  const cleaned = cleanSnapshot({
    transport: 'local',
    isCharging: false,
    voltage: 230,
    current: 0,
    power: 0,
  }, {
    phaseCount: 3,
    shadowMaxCurrent: 10,
  });

  assert.equal(cleaned.power, 0);
});
