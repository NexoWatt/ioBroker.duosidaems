'use strict';

const STATUS_NAMES = Object.freeze({
  '-1': 'Undefined',
  '0': 'Available',
  '1': 'Preparing',
  '2': 'Charging',
  '3': 'Cooling',
  '4': 'SuspendedEV',
  '5': 'Finished',
  '6': 'Holiday',
});

function normalizeStateCode(code) {
  if (code === null || code === undefined || code === '') {
    return null;
  }
  const normalized = Number(code);
  if (!Number.isFinite(normalized)) {
    return null;
  }
  return Math.trunc(normalized);
}

function statusCodeToState(code) {
  const normalized = normalizeStateCode(code);
  if (normalized === null) {
    return 'Unknown';
  }
  return STATUS_NAMES[String(normalized)] || `Unknown (${normalized})`;
}

function isChargingState(code) {
  const normalized = normalizeStateCode(code);
  return normalized === 2 || normalized === 3;
}

function isVehicleConnectedState(code) {
  const normalized = normalizeStateCode(code);
  return [1, 2, 3, 4, 5].includes(normalized);
}

module.exports = {
  STATUS_NAMES,
  normalizeStateCode,
  statusCodeToState,
  isChargingState,
  isVehicleConnectedState,
};
