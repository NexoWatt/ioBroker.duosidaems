'use strict';

function asFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundNumber(value, decimals = 2) {
  const numeric = asFiniteNumber(value);
  if (numeric === null) {
    return null;
  }
  const factor = 10 ** Math.max(0, decimals);
  return Math.round(numeric * factor) / factor;
}

function normalizePhaseCount(value, fallback = 3) {
  const numeric = asFiniteNumber(value);
  const integer = numeric === null ? null : Math.trunc(numeric);
  if (integer === 1 || integer === 3) {
    return integer;
  }
  return fallback === 1 ? 1 : 3;
}

function sanitizeSessionFields(snapshot, nowMs = Date.now()) {
  let sessionStartTsMs = asFiniteNumber(snapshot.sessionStartTsMs);
  let sessionDurationMin = asFiniteNumber(snapshot.sessionDurationMin);

  const minValidTs = Date.UTC(2020, 0, 1);
  const maxFutureOffsetMs = 60 * 60 * 1000;
  const maxAgeMs = 72 * 60 * 60 * 1000;

  if (sessionStartTsMs !== null) {
    if (
      sessionStartTsMs < minValidTs
      || sessionStartTsMs > nowMs + maxFutureOffsetMs
      || nowMs - sessionStartTsMs > maxAgeMs
    ) {
      sessionStartTsMs = null;
    }
  }

  if (sessionStartTsMs !== null) {
    sessionDurationMin = Math.max(0, Math.round((nowMs - sessionStartTsMs) / 60000));
  } else if (sessionDurationMin !== null && sessionDurationMin > Math.round(maxAgeMs / 60000)) {
    sessionDurationMin = null;
  }

  if (sessionDurationMin !== null) {
    sessionDurationMin = Math.round(sessionDurationMin);
  }

  return {
    sessionStartTsMs,
    sessionDurationMin,
  };
}

function chooseEffectiveCurrent({ measuredCurrent, configuredCurrent, isCharging }) {
  const measured = asFiniteNumber(measuredCurrent);
  const configured = asFiniteNumber(configuredCurrent);

  if (measured !== null && configured !== null && Math.abs(measured - configured) <= 0.5) {
    return configured;
  }

  if (measured !== null) {
    return measured;
  }

  if (Boolean(isCharging) && configured !== null) {
    return configured;
  }

  return null;
}

function computeDerivedPower({
  transport,
  voltage,
  current,
  configuredCurrent,
  explicitPower,
  phaseCount = 3,
  isCharging,
}) {
  const measuredVoltage = asFiniteNumber(voltage);
  const measuredCurrent = asFiniteNumber(current);
  const configured = asFiniteNumber(configuredCurrent);
  const explicit = asFiniteNumber(explicitPower);
  const phases = normalizePhaseCount(phaseCount);

  if (!Boolean(isCharging) && (measuredCurrent === null || measuredCurrent < 0.2)) {
    return explicit !== null && explicit >= 0 && explicit <= 50 ? 0 : explicit;
  }

  const effectiveCurrent = chooseEffectiveCurrent({
    measuredCurrent,
    configuredCurrent: configured,
    isCharging,
  });

  const computedPower = measuredVoltage !== null && effectiveCurrent !== null
    ? measuredVoltage * effectiveCurrent * phases
    : null;

  if (transport === 'local') {
    return computedPower;
  }

  if (explicit === null) {
    return computedPower;
  }

  if (computedPower !== null && effectiveCurrent !== null && effectiveCurrent >= 1) {
    if (explicit <= 50 || explicit < computedPower * 0.15) {
      return computedPower;
    }
  }

  return explicit;
}

function cleanSnapshot(snapshot, options = {}) {
  const nowMs = options.nowMs || Date.now();
  const phaseCount = normalizePhaseCount(options.phaseCount, 3);
  const shadowMaxCurrent = asFiniteNumber(options.shadowMaxCurrent);

  const cleaned = {
    ...snapshot,
  };

  const maxCurrent = asFiniteNumber(snapshot.maxCurrent) ?? shadowMaxCurrent;

  cleaned.voltage = roundNumber(snapshot.voltage, 2);
  cleaned.voltage2 = roundNumber(snapshot.voltage2, 2);
  cleaned.voltage3 = roundNumber(snapshot.voltage3, 2);
  cleaned.current = roundNumber(snapshot.current, 2);
  cleaned.current2 = roundNumber(snapshot.current2, 2);
  cleaned.current3 = roundNumber(snapshot.current3, 2);
  cleaned.temperature = roundNumber(snapshot.temperature, 2);
  cleaned.temperatureInternal = roundNumber(snapshot.temperatureInternal, 2);
  cleaned.cpVoltage = roundNumber(snapshot.cpVoltage, 2);
  cleaned.sessionEnergy = roundNumber(snapshot.sessionEnergy, 2);
  cleaned.energyToday = roundNumber(snapshot.energyToday, 2);
  cleaned.energyTotal = roundNumber(snapshot.energyTotal, 2);
  cleaned.accEnergy = roundNumber(snapshot.accEnergy, 2);
  cleaned.accEnergy2 = roundNumber(snapshot.accEnergy2, 2);
  cleaned.maxCurrent = roundNumber(maxCurrent, 2);

  const session = sanitizeSessionFields(snapshot, nowMs);
  cleaned.sessionStartTsMs = session.sessionStartTsMs;
  cleaned.sessionDurationMin = session.sessionDurationMin;

  const derivedPower = computeDerivedPower({
    transport: snapshot.transport,
    voltage: cleaned.voltage,
    current: cleaned.current,
    configuredCurrent: cleaned.maxCurrent,
    explicitPower: snapshot.power,
    phaseCount,
    isCharging: snapshot.isCharging,
  });

  const powerDecimals = derivedPower !== null && Math.abs(derivedPower) >= 100 ? 0 : 2;
  cleaned.power = roundNumber(derivedPower, powerDecimals);

  return cleaned;
}

module.exports = {
  asFiniteNumber,
  roundNumber,
  normalizePhaseCount,
  sanitizeSessionFields,
  computeDerivedPower,
  cleanSnapshot,
};
