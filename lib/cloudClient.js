'use strict';

const https = require('node:https');

const { normalizeStateCode, statusCodeToState, isChargingState } = require('./status');

const CLOUD_BASE_URL = 'https://cpam3.x-cheng.com/cpAm2/';

function normalizeNumberLike(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeBooleanLike(value) {
  if (value === true || value === false) {
    return value;
  }
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isNaN(numeric)) {
    return numeric !== 0;
  }
  const lowered = String(value).trim().toLowerCase();
  if (['true', 'yes', 'on'].includes(lowered)) {
    return true;
  }
  if (['false', 'no', 'off'].includes(lowered)) {
    return false;
  }
  return null;
}

function normalizeStringLike(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function isSameLocalDay(leftDate, rightDate) {
  return (
    leftDate.getFullYear() === rightDate.getFullYear()
    && leftDate.getMonth() === rightDate.getMonth()
    && leftDate.getDate() === rightDate.getDate()
  );
}

function summarizeChargeRecords(records, now = new Date()) {
  const chartList = Array.isArray(records && records.chartList) ? records.chartList : [];
  let todayConsumption = 0;
  let totalConsumption = 0;

  for (const row of chartList) {
    const energy = normalizeNumberLike(row && row.energy) || 0;
    totalConsumption += energy;

    const timestampStop = normalizeNumberLike(row && row.timestampStop);
    if (!timestampStop) {
      continue;
    }

    const chargeDate = new Date(timestampStop);
    if (isSameLocalDay(chargeDate, now)) {
      todayConsumption += energy;
    }
  }

  return {
    todayConsumption: Number(todayConsumption.toFixed(3)),
    totalConsumption: Number(totalConsumption.toFixed(3)),
  };
}

function normalizeCloudSnapshot({ device = {}, detail = {}, config = {}, records = {} }) {
  const summary = summarizeChargeRecords(records);
  const stateCode = normalizeStateCode(detail.connStatus ?? device.connStatus);
  const voltage = normalizeNumberLike(detail.voltage);
  const current = normalizeNumberLike(detail.current);
  const explicitPower = normalizeNumberLike(detail.power);
  const computedPower = voltage !== null && current !== null ? Number((voltage * current).toFixed(2)) : null;
  const accEnergy = normalizeNumberLike(detail.accEnergy);

  const maxCurrent = normalizeNumberLike(
    detail.maxCurrent
      ?? config.maxCurrent
      ?? config.VendorMaxWorkCurrent
      ?? config.vendorMaxWorkCurrent,
  );
  const directWorkMode = normalizeBooleanLike(
    config.directWorkMode
      ?? config.VendorDirectWorkMode
      ?? config.vendorDirectWorkMode,
  );
  const levelDetection = normalizeBooleanLike(
    config.levelDetection
      ?? config.CheckCpN12V
      ?? config.checkCpN12V,
  );
  const stopOnDisconnect = normalizeBooleanLike(
    config.stopTranOnEVSideDiscon
      ?? config.StopTransactionOnEVSideDisconnect
      ?? config.stopTransactionOnEVSideDisconnect,
  );
  const ledBrightness = normalizeNumberLike(
    config.ledStrength
      ?? config.VendorLEDStrength
      ?? config.vendorLedStrength,
  );

  return {
    transport: 'cloud',
    host: 'cpam3.x-cheng.com',
    deviceId: normalizeStringLike(device.id ?? detail.id ?? config.cpId),
    name: normalizeStringLike(device.pileName),
    model: normalizeStringLike(device.chargePointModel),
    manufacturer: normalizeStringLike(device.chargePointVendor),
    firmware: normalizeStringLike(device.firmwareVersion),
    serialNumber: normalizeStringLike(device.chargePointSerialNumber),
    reportedOnline: normalizeBooleanLike(device.isOnline),
    stateCode,
    state: statusCodeToState(stateCode),
    isCharging: isChargingState(stateCode),
    voltage,
    voltage2: normalizeNumberLike(detail.voltage2),
    voltage3: normalizeNumberLike(detail.voltage3),
    current,
    current2: normalizeNumberLike(detail.current2),
    current3: normalizeNumberLike(detail.current3),
    power: explicitPower !== null ? explicitPower : computedPower,
    temperature: normalizeNumberLike(detail.temperature),
    temperatureInternal: null,
    cpVoltage: null,
    sessionEnergy: null,
    sessionStartTsMs: null,
    sessionDurationMin: null,
    energyToday: summary.todayConsumption,
    energyTotal: accEnergy !== null ? accEnergy : summary.totalConsumption,
    accEnergy,
    accEnergy2: normalizeNumberLike(detail.accEnergy2),
    maxCurrent,
    errorCode: normalizeNumberLike(detail.errorCode),
    directWorkMode,
    levelDetection,
    stopOnDisconnect,
    ledBrightness,
  };
}

class CloudClient {
  constructor(options) {
    this.username = options.username;
    this.password = options.password;
    this.deviceId = options.deviceId || '';
    this.allowInsecureTls = options.allowInsecureTls !== false;
    this.logger = options.logger || console;
    this.token = '';
    this.agent = new https.Agent({
      rejectUnauthorized: !this.allowInsecureTls,
    });
  }

  setDeviceId(deviceId) {
    this.deviceId = deviceId || '';
  }

  async _request(method, path, options = {}) {
    const url = new URL(path, CLOUD_BASE_URL);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== null && value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers = {
      Accept: 'application/json, text/plain, */*',
    };

    let payload = null;
    if (options.form) {
      payload = new URLSearchParams(options.form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (options.body !== undefined && options.body !== null) {
      payload = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }

    if (payload !== null) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    if (this.token && !options.skipToken) {
      headers.token = this.token;
    }

    return new Promise((resolve, reject) => {
      const request = https.request(
        url,
        {
          method,
          headers,
          agent: this.agent,
        },
        response => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', async () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const statusCode = response.statusCode || 0;

            if (statusCode === 405 && options.retryToken !== false && !options.skipToken) {
              try {
                await this.login();
                const retried = await this._request(method, path, {
                  ...options,
                  retryToken: false,
                });
                resolve(retried);
                return;
              } catch (error) {
                reject(error);
                return;
              }
            }

            if (statusCode === 404) {
              resolve(null);
              return;
            }

            if (statusCode < 200 || statusCode >= 300) {
              reject(new Error(`Cloud request failed (${statusCode}) for ${method} ${path}: ${raw.slice(0, 300)}`));
              return;
            }

            if (!raw) {
              resolve(null);
              return;
            }

            try {
              const parsed = JSON.parse(raw);
              if (Object.prototype.hasOwnProperty.call(parsed, 'bizData')) {
                resolve(parsed.bizData);
              } else {
                resolve(parsed);
              }
            } catch (error) {
              reject(new Error(`Failed to parse cloud JSON for ${method} ${path}: ${error.message}`));
            }
          });
        },
      );

      request.on('error', reject);

      if (payload !== null) {
        request.write(payload);
      }
      request.end();
    });
  }

  async login() {
    const response = await this._request('POST', 'login', {
      form: {
        username: this.username,
        password: this.password,
        language: 'en_us',
      },
      skipToken: true,
    });

    const token = response && response.token ? String(response.token) : '';
    if (!token) {
      throw new Error('Cloud login succeeded but did not return a token');
    }

    this.token = token;
    return token;
  }

  async ensureLogin() {
    if (!this.token) {
      await this.login();
    }
  }

  async getDevices() {
    await this.ensureLogin();
    const response = await this._request('GET', 'cp/deviceList');
    return Array.isArray(response && response.deviceList) ? response.deviceList : [];
  }

  async getDeviceDetail(deviceId = this.deviceId) {
    if (!deviceId) {
      throw new Error('Cloud device ID is required for getDeviceDetail');
    }
    await this.ensureLogin();
    return (await this._request('GET', `cp/deviceDetailRepeat/${deviceId}`)) || {};
  }

  async getDeviceConfig(deviceId = this.deviceId) {
    if (!deviceId) {
      throw new Error('Cloud device ID is required for getDeviceConfig');
    }
    await this.ensureLogin();
    return (await this._request('GET', `cp/getCpConfig/${deviceId}`)) || {};
  }

  async getChargingRecord(deviceId = this.deviceId) {
    if (!deviceId) {
      throw new Error('Cloud device ID is required for getChargingRecord');
    }
    await this.ensureLogin();
    return (await this._request('GET', `tran/chargeRecordList/${deviceId}`)) || {};
  }

  async getDeviceById(deviceId = this.deviceId) {
    const devices = await this.getDevices();
    const match = devices.find(device => String(device.id) === String(deviceId));
    if (!match) {
      return null;
    }
    return match;
  }

  async getSnapshot(deviceId = this.deviceId, knownDevice = null, includeRecords = true) {
    if (!deviceId) {
      throw new Error('Cloud device ID is required for getSnapshot');
    }

    const device = knownDevice || await this.getDeviceById(deviceId);
    if (!device) {
      throw new Error(`Cloud device ${deviceId} was not found`);
    }

    const [detail, config, records] = await Promise.all([
      this.getDeviceDetail(deviceId),
      this.getDeviceConfig(deviceId),
      includeRecords ? this.getChargingRecord(deviceId) : Promise.resolve({}),
    ]);

    return normalizeCloudSnapshot({
      device,
      detail,
      config,
      records,
    });
  }

  async setProperty(deviceId, key, value) {
    if (!deviceId) {
      throw new Error('Cloud device ID is required for setProperty');
    }
    await this.ensureLogin();
    return this._request('POST', `cp/changeCpConfig/${deviceId}`, {
      body: {
        key,
        value,
      },
    });
  }

  async setMaxCurrent(deviceId, amps) {
    const numeric = Number(amps);
    if (!Number.isInteger(numeric) || numeric < 6 || numeric > 32) {
      throw new Error('Cloud max current must be an integer between 6 and 32 A');
    }
    return this.setProperty(deviceId, 'VendorMaxWorkCurrent', numeric);
  }

  async setDirectWorkMode(deviceId, enabled) {
    return this.setProperty(deviceId, 'VendorDirectWorkMode', enabled ? 1 : 0);
  }

  async setLevelDetection(deviceId, enabled) {
    return this.setProperty(deviceId, 'CheckCpN12V', enabled ? 1 : 0);
  }

  async setStopOnDisconnect(deviceId, enabled) {
    return this.setProperty(deviceId, 'StopTransactionOnEVSideDisconnect', enabled ? 1 : 0);
  }

  async setLedBrightness(deviceId, level) {
    const numeric = Number(level);
    if (!Number.isInteger(numeric) || ![0, 1, 3].includes(numeric)) {
      throw new Error('LED brightness must be one of: 0, 1, 3');
    }
    return this.setProperty(deviceId, 'VendorLEDStrength', numeric);
  }

  async startCharging(deviceId = this.deviceId) {
    if (!deviceId) {
      throw new Error('Cloud device ID is required for startCharging');
    }
    await this.ensureLogin();
    return this._request('POST', `cp/startCharge/${deviceId}`);
  }

  async stopCharging(deviceId = this.deviceId) {
    if (!deviceId) {
      throw new Error('Cloud device ID is required for stopCharging');
    }
    await this.ensureLogin();
    return this._request('GET', `cp/stopCharge/${deviceId}`);
  }
}

module.exports = {
  CLOUD_BASE_URL,
  CloudClient,
  normalizeBooleanLike,
  normalizeNumberLike,
  normalizeStringLike,
  summarizeChargeRecords,
  normalizeCloudSnapshot,
};
