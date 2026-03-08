'use strict';

const net = require('node:net');

const {
  encodeEmbeddedMessage,
  encodeString,
  encodeVarintField,
  decodeMessage,
  maybeDecodeUtf8,
} = require('./protobuf');
const { normalizeStateCode, statusCodeToState, isChargingState } = require('./status');

const HANDSHAKE_1 = Buffer.from('a2030408001000a20603494f53a80600', 'hex');
const HANDSHAKE_2 = Buffer.concat([
  Buffer.from('1a0a089ee6da910d10001800', 'hex'),
  Buffer.from('a2061330333130313037313132313232333630333734', 'hex'),
  Buffer.from('a8069e818040', 'hex'),
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeString(value) {
  return String(value || '')
    .replace(/[\u0000-\u001F]+/g, '')
    .trim();
}

function extractDeviceIdFromHandshakeFrame(frame) {
  if (!frame || frame.length === 0) {
    return null;
  }
  const ascii = frame.toString('utf8');
  const preferred = ascii.match(/03\d{17}/);
  if (preferred) {
    return preferred[0];
  }
  const anyDigits = ascii.match(/\d{19}/);
  return anyDigits ? anyDigits[0] : null;
}

function parseDeviceInfoString(deviceInfo, deviceId = '') {
  const info = String(deviceInfo || '');
  let model = '';
  let manufacturer = '';
  let firmware = '';

  if (info.includes('\x12')) {
    const modelStart = info.indexOf('\x12') + 2;
    if (deviceId && info.includes(deviceId)) {
      const modelEnd = info.indexOf(deviceId);
      const modelSection = info.slice(modelStart, modelEnd);
      model = sanitizeString(modelSection.replace(/\x1a\x13$/g, ''));
    }
  }

  if (deviceId && info.includes(deviceId)) {
    const afterId = info.split(deviceId, 2)[1];
    if (afterId.includes('*-')) {
      const [manufacturerPart, firmwarePart] = afterId.split('*-', 2);
      manufacturer = sanitizeString(manufacturerPart.replace(/"/g, ''));
      firmware = sanitizeString(firmwarePart.replace(/:/g, ''));
    }
  }

  return { model, manufacturer, firmware };
}

class BufferedSocket {
  constructor(socket) {
    this.socket = socket;
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    this.error = null;

    socket.on('data', chunk => {
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.resolve(chunk);
      } else {
        this.queue.push(chunk);
      }
    });

    socket.on('error', error => {
      this.error = error;
      while (this.waiters.length) {
        this.waiters.shift().reject(error);
      }
    });

    socket.on('close', () => {
      this.closed = true;
      while (this.waiters.length) {
        this.waiters.shift().reject(new Error('Socket closed before data was received'));
      }
    });
  }

  write(data) {
    return new Promise((resolve, reject) => {
      this.socket.write(data, error => (error ? reject(error) : resolve()));
    });
  }

  nextChunk(timeoutMs) {
    if (this.queue.length) {
      return Promise.resolve(this.queue.shift());
    }
    if (this.error) {
      return Promise.reject(this.error);
    }
    if (this.closed) {
      return Promise.reject(new Error('Socket already closed'));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(waiter => waiter.resolve !== resolve);
        reject(new Error(`Read timeout after ${timeoutMs} ms`));
      }, timeoutMs);

      this.waiters.push({
        resolve: chunk => {
          clearTimeout(timer);
          resolve(chunk);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  destroy() {
    try {
      this.socket.destroy();
    } catch {
      // ignore
    }
  }
}

async function openBufferedSocket({ host, port, timeoutMs }) {
  const socket = new net.Socket();
  socket.setTimeout(timeoutMs);

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error(`Connection timeout after ${timeoutMs} ms`));
    };

    socket.once('error', onError);
    socket.once('timeout', onTimeout);
    socket.connect(port, host, () => {
      cleanup();
      resolve();
    });
  });

  return new BufferedSocket(socket);
}

class LocalClient {
  constructor(options) {
    this.host = options.host;
    this.port = options.port || 9988;
    this.deviceId = options.deviceId || '';
    this.timeoutMs = options.timeoutMs || 5000;
    this.sequence = 2;
    this.logger = options.logger || console;
    this.logRawFrames = Boolean(options.logRawFrames);
  }

  setHost(host) {
    this.host = host;
  }

  setDeviceId(deviceId) {
    this.deviceId = deviceId || '';
  }

  async _withSession(callback) {
    const session = await openBufferedSocket({
      host: this.host,
      port: this.port,
      timeoutMs: this.timeoutMs,
    });

    try {
      return await callback(session);
    } finally {
      session.destroy();
    }
  }

  async _sendHandshake(session) {
    await session.write(HANDSHAKE_1);
    await sleep(100);

    try {
      await session.nextChunk(1000);
    } catch {
      // The first response is optional for us.
    }

    await session.write(HANDSHAKE_2);
    await sleep(200);
    this.sequence += 1;
  }

  async _readDeviceIdViaTcp() {
    return this._withSession(async session => {
      await session.write(HANDSHAKE_1);
      await sleep(100);

      try {
        const firstChunk = await session.nextChunk(1000);
        const firstId = extractDeviceIdFromHandshakeFrame(firstChunk);
        if (firstId) {
          return firstId;
        }
      } catch {
        // ignore and continue
      }

      try {
        await session.write(HANDSHAKE_2);
        await sleep(150);
        const secondChunk = await session.nextChunk(1000);
        return extractDeviceIdFromHandshakeFrame(secondChunk);
      } catch {
        return null;
      }
    });
  }

  async ensureDeviceId() {
    if (this.deviceId) {
      return this.deviceId;
    }
    const resolved = await this._readDeviceIdViaTcp();
    if (!resolved) {
      throw new Error('Could not resolve local device ID via TCP');
    }
    this.deviceId = resolved;
    return resolved;
  }

  _buildConfigMessage(key, value) {
    const commandData = Buffer.concat([
      encodeString(1, key),
      encodeString(2, String(value)),
    ]);

    return Buffer.concat([
      encodeEmbeddedMessage(10, commandData),
      encodeString(100, this.deviceId),
      encodeVarintField(101, this.sequence),
    ]);
  }

  _buildStartMessage() {
    const innerData = encodeString(1, 'XC_Remote_Tag');
    const commandData = Buffer.concat([
      encodeVarintField(1, 1),
      encodeEmbeddedMessage(2, innerData),
    ]);

    return Buffer.concat([
      encodeEmbeddedMessage(34, commandData),
      encodeString(100, this.deviceId),
      encodeVarintField(101, this.sequence),
    ]);
  }

  _buildStopMessage(sessionId) {
    const commandData = encodeVarintField(1, sessionId);
    return Buffer.concat([
      encodeEmbeddedMessage(36, commandData),
      encodeString(100, this.deviceId),
      encodeVarintField(101, this.sequence),
    ]);
  }

  async _sendCommand(buildMessage) {
    await this.ensureDeviceId();

    return this._withSession(async session => {
      await this._sendHandshake(session);
      const message = buildMessage();
      await session.write(message);
      this.sequence += 1;
      await sleep(300);
      return true;
    });
  }

  _parseStatusFrame(frame) {
    if (this.logRawFrames) {
      this.logger.debug(`Received local frame with ${frame.length} bytes`);
    }

    const outerFields = decodeMessage(frame);

    let deviceId = maybeDecodeUtf8(outerFields[100]) || this.deviceId || extractDeviceIdFromHandshakeFrame(frame) || '';
    deviceId = sanitizeString(deviceId);

    let model = '';
    let manufacturer = '';
    let firmware = '';

    if (outerFields[4]) {
      const deviceInfo = maybeDecodeUtf8(outerFields[4]);
      const parsedInfo = parseDeviceInfoString(deviceInfo, deviceId);
      model = parsedInfo.model;
      manufacturer = parsedInfo.manufacturer;
      firmware = parsedInfo.firmware;
    }

    let fields = outerFields;
    if (Buffer.isBuffer(outerFields[16])) {
      const innerFields = decodeMessage(outerFields[16]);
      const messageType = sanitizeString(maybeDecodeUtf8(innerFields[2]));

      if (messageType === 'DataVendorStatusReq') {
        if (!Buffer.isBuffer(innerFields[10])) {
          return null;
        }
        fields = decodeMessage(innerFields[10]);
      } else if (messageType === 'DataContinueReq') {
        return null;
      } else if (Buffer.isBuffer(innerFields[10])) {
        fields = decodeMessage(innerFields[10]);
      } else if (Buffer.isBuffer(innerFields[12])) {
        fields = decodeMessage(innerFields[12]);
      } else {
        fields = innerFields;
      }
    }

    const hasKeyFields = [1, 2, 8, 17].some(fieldNumber =>
      Object.prototype.hasOwnProperty.call(fields, fieldNumber),
    );
    if (!hasKeyFields) {
      return null;
    }

    const getNumber = fieldNumber => {
      const value = fields[fieldNumber];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    };

    const voltage = getNumber(1);
    const current = getNumber(2);
    const stateCode = normalizeStateCode(getNumber(17) ?? 0);
    const sessionStartSeconds = getNumber(18);
    const sessionStartTsMs = sessionStartSeconds ? Math.trunc(sessionStartSeconds * 1000) : null;
    const sessionDurationMin = sessionStartTsMs
      ? Math.max(0, Math.floor((Date.now() - sessionStartTsMs) / 60000))
      : null;

    let power = getNumber(3);
    if (power === null && voltage !== null && current !== null) {
      power = Number((voltage * current).toFixed(2));
    }

    return {
      transport: 'local',
      host: this.host,
      deviceId,
      name: null,
      model: model || null,
      manufacturer: manufacturer || null,
      firmware: firmware || null,
      serialNumber: null,
      reportedOnline: true,
      stateCode,
      state: statusCodeToState(stateCode),
      isCharging: isChargingState(stateCode),
      voltage,
      voltage2: null,
      voltage3: null,
      current,
      current2: null,
      current3: null,
      power,
      temperature: getNumber(8),
      temperatureInternal: getNumber(7),
      cpVoltage: getNumber(9),
      sessionEnergy: getNumber(4),
      sessionStartTsMs,
      sessionDurationMin,
      energyToday: null,
      energyTotal: null,
      accEnergy: null,
      accEnergy2: null,
      maxCurrent: null,
      errorCode: null,
      directWorkMode: null,
      levelDetection: null,
      stopOnDisconnect: null,
      ledBrightness: null,
    };
  }

  async readStatus(maxFrames = 5) {
    return this._withSession(async session => {
      await this._sendHandshake(session);

      const deadline = Date.now() + Math.max(this.timeoutMs, 2500);
      let framesLeft = maxFrames;

      while (Date.now() < deadline && framesLeft > 0) {
        const remaining = Math.max(250, deadline - Date.now());
        const chunk = await session.nextChunk(remaining);
        const parsed = this._parseStatusFrame(chunk);
        if (parsed) {
          if (parsed.deviceId && !this.deviceId) {
            this.deviceId = parsed.deviceId;
          }
          return parsed;
        }
        framesLeft -= 1;
      }

      throw new Error('No local status frame received');
    });
  }

  async setMaxCurrent(amps) {
    const numeric = Number(amps);
    if (!Number.isInteger(numeric) || numeric < 6 || numeric > 32) {
      throw new Error('Max current must be an integer between 6 and 32 A');
    }

    return this._sendCommand(() => this._buildConfigMessage('VendorMaxWorkCurrent', String(numeric)));
  }

  async setConfig(key, value) {
    if (!key) {
      throw new Error('Configuration key is required');
    }
    return this._sendCommand(() => this._buildConfigMessage(key, String(value)));
  }

  async setDirectWorkMode(enabled) {
    return this.setConfig('VendorDirectWorkMode', enabled ? '1' : '0');
  }

  async setLevelDetection(enabled) {
    return this.setConfig('CheckCpN12V', enabled ? '1' : '0');
  }

  async setStopOnDisconnect(enabled) {
    return this.setConfig('StopTransactionOnEVSideDisconnect', enabled ? '1' : '0');
  }

  async setLedBrightness(level) {
    const numeric = Number(level);
    if (!Number.isInteger(numeric) || ![0, 1, 3].includes(numeric)) {
      throw new Error('LED brightness must be one of: 0, 1, 3');
    }
    return this.setConfig('VendorLEDStrength', String(numeric));
  }

  async startCharging() {
    return this._sendCommand(() => this._buildStartMessage());
  }

  async stopCharging(sessionId) {
    const normalizedSessionId = Number.isInteger(Number(sessionId))
      ? Number(sessionId)
      : Date.now() % 0xFFFFFFFF;
    return this._sendCommand(() => this._buildStopMessage(normalizedSessionId));
  }
}

async function getDeviceIdViaTcp(host, options = {}) {
  const client = new LocalClient({
    host,
    port: options.port || 9988,
    timeoutMs: options.timeoutMs || 3000,
    logger: options.logger || console,
    logRawFrames: false,
  });
  return client._readDeviceIdViaTcp();
}

module.exports = {
  HANDSHAKE_1,
  HANDSHAKE_2,
  LocalClient,
  extractDeviceIdFromHandshakeFrame,
  parseDeviceInfoString,
  getDeviceIdViaTcp,
};
