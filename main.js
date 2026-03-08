'use strict';

const utils = require('@iobroker/adapter-core');

const { getObjectDefinitions } = require('./lib/objectDefinitions');
const { LocalClient, getDeviceIdViaTcp } = require('./lib/localClient');
const { discoverChargers } = require('./lib/discovery');
const { CloudClient } = require('./lib/cloudClient');

const CONTROL_STATE_IDS = [
  'charger.control.maxCurrent',
  'charger.control.directWorkMode',
  'charger.control.levelDetection',
  'charger.control.stopOnDisconnect',
  'charger.control.ledBrightness',
];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeTransport(value) {
  const normalized = String(value || 'auto').trim().toLowerCase();
  if (['local', 'cloud', 'auto'].includes(normalized)) {
    return normalized;
  }
  return 'auto';
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function asInteger(value) {
  const numeric = asNumber(value);
  return numeric === null ? null : Math.trunc(numeric);
}

function asBoolean(value) {
  if (value === true || value === false) {
    return value;
  }
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const lowered = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(lowered)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(lowered)) {
    return false;
  }
  return null;
}

class Duosidaems extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: 'duosidaems',
    });

    this.pollTimer = null;
    this.maxCurrentTimer = null;
    this.pendingMaxCurrent = null;
    this.serialQueue = Promise.resolve();
    this.activeTransport = null;
    this.localClient = null;
    this.cloudClient = null;
    this.currentCloudDevice = null;
    this.commandShadow = new Map();
    this.lastWriteAt = 0;
    this.consecutivePollFailures = 0;
    this.transportSwitchCount = 0;

    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  async onReady() {
    await this.ensureObjects();
    await this.loadCommandShadow();
    await this.setStateSafe('info.transportConfigured', normalizeTransport(this.config.transport), true);
    await this.setStateSafe('info.transportActive', '', true);
    await this.setStateSafe('info.connection', false, true);
    await this.setStateSafe('info.lastError', '', true);
    await this.subscribeStatesAsync('charger.control.*');

    try {
      const snapshot = await this.initializeTransport();
      if (snapshot) {
        await this.applySnapshot(snapshot);
      }
    } catch (error) {
      await this.handleError(error, 'startup');
    }

    this.schedulePoll(1000);
  }

  onUnload(callback) {
    try {
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
      if (this.maxCurrentTimer) {
        clearTimeout(this.maxCurrentTimer);
        this.maxCurrentTimer = null;
      }
      callback();
    } catch (error) {
      callback(error);
    }
  }

  async ensureObjects() {
    for (const definition of getObjectDefinitions()) {
      await this.extendObjectAsync(definition.id, {
        type: definition.type,
        common: definition.common,
        native: definition.native || {},
      });
    }
  }

  async loadCommandShadow() {
    for (const id of CONTROL_STATE_IDS) {
      const state = await this.getStateAsync(id);
      if (state && state.ack) {
        this.commandShadow.set(id, state.val);
      }
    }
  }

  schedulePoll(delayMs) {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollNow();
    }, delayMs);
  }

  scheduleFastPoll(delayMs = 800) {
    this.schedulePoll(delayMs);
  }

  async initializeTransport() {
    const configuredTransport = normalizeTransport(this.config.transport);

    if (configuredTransport === 'local') {
      return this.activateLocalTransport();
    }
    if (configuredTransport === 'cloud') {
      return this.activateCloudTransport();
    }

    try {
      return await this.activateLocalTransport();
    } catch (localError) {
      this.log.warn(`Auto mode: local transport failed during startup: ${localError.message}`);
      return this.activateCloudTransport();
    }
  }

  async resolveLocalEndpoint() {
    const configuredHost = String(this.config.host || '').trim();
    const configuredDeviceId = String(this.config.localDeviceId || '').trim();

    if (configuredHost) {
      return {
        host: configuredHost,
        deviceId: configuredDeviceId || null,
      };
    }

    if (!this.config.discoveryOnStart) {
      throw new Error('Local transport requires host/IP or startup discovery');
    }

    const discovered = await discoverChargers({
      timeoutMs: (asInteger(this.config.discoveryTimeoutSec) || 4) * 1000,
      interfaceAddress: String(this.config.discoveryInterface || '0.0.0.0').trim() || '0.0.0.0',
      includeDeviceId: true,
      port: asInteger(this.config.port) || 9988,
      logger: this.log,
    });

    if (!discovered.length) {
      throw new Error('No Duosida charger found via local UDP discovery');
    }

    let selected = null;
    if (configuredDeviceId) {
      selected = discovered.find(device => String(device.deviceId || '') === configuredDeviceId) || null;
    }

    if (!selected) {
      selected = discovered[0];
      if (discovered.length > 1) {
        this.log.warn(`Local discovery found ${discovered.length} chargers. Using the first one: ${selected.ip}`);
      }
    }

    return {
      host: selected.ip,
      deviceId: selected.deviceId || null,
    };
  }

  async activateLocalTransport() {
    const endpoint = await this.resolveLocalEndpoint();
    const localClient = new LocalClient({
      host: endpoint.host,
      port: asInteger(this.config.port) || 9988,
      deviceId: endpoint.deviceId || '',
      timeoutMs: asInteger(this.config.localTimeoutMs) || 5000,
      logger: this.log,
      logRawFrames: Boolean(this.config.logRawFrames),
    });

    if (!localClient.deviceId) {
      try {
        const resolvedDeviceId = await getDeviceIdViaTcp(endpoint.host, {
          port: asInteger(this.config.port) || 9988,
          timeoutMs: asInteger(this.config.localTimeoutMs) || 5000,
          logger: this.log,
        });
        if (resolvedDeviceId) {
          localClient.setDeviceId(resolvedDeviceId);
        }
      } catch {
        // ignore here; a later status poll may still reveal the device ID
      }
    }

    const snapshot = await localClient.readStatus();
    this.localClient = localClient;
    this.cloudClient = null;
    this.currentCloudDevice = null;
    await this.setActiveTransport('local');
    return snapshot;
  }

  async resolveCloudSelection(cloudClient) {
    const devices = await cloudClient.getDevices();
    if (!devices.length) {
      throw new Error('No cloud devices returned by X-Cheng backend');
    }

    const configuredDeviceId = String(this.config.cloudDeviceId || '').trim();
    let selected = null;

    if (configuredDeviceId) {
      selected = devices.find(device => String(device.id) === configuredDeviceId) || null;
      if (!selected) {
        throw new Error(`Configured cloud device ID ${configuredDeviceId} was not found`);
      }
    }

    if (!selected) {
      selected = devices[0];
      if (devices.length > 1) {
        this.log.warn(`Cloud account returned ${devices.length} chargers. Using the first one: ${selected.id}`);
      }
    }

    return selected;
  }

  async activateCloudTransport() {
    const username = String(this.config.cloudUsername || '').trim();
    const password = String(this.config.cloudPassword || '');

    if (!username || !password) {
      throw new Error('Cloud transport requires username and password');
    }

    const cloudClient = new CloudClient({
      username,
      password,
      allowInsecureTls: this.config.allowInsecureTls !== false,
      logger: this.log,
    });

    await cloudClient.login();
    const selected = await this.resolveCloudSelection(cloudClient);
    cloudClient.setDeviceId(String(selected.id));

    const snapshot = await cloudClient.getSnapshot(
      String(selected.id),
      selected,
      this.config.requestChargeRecords !== false,
    );

    this.cloudClient = cloudClient;
    this.currentCloudDevice = selected;
    this.localClient = null;
    await this.setActiveTransport('cloud');
    return snapshot;
  }

  async setActiveTransport(transport) {
    const previous = this.activeTransport;
    this.activeTransport = transport;
    if (previous && previous !== transport) {
      this.transportSwitchCount += 1;
      await this.clearTransportSpecificStates(transport);
    }
    await this.setStateSafe('info.transportActive', transport, true);
  }

  async clearTransportSpecificStates(activeTransport) {
    if (activeTransport === 'cloud') {
      await this.setStateSafe('charger.status.cpVoltage', null, true);
      await this.setStateSafe('charger.status.temperatureInternal', null, true);
      await this.setStateSafe('charger.status.sessionEnergy', null, true);
      await this.setStateSafe('charger.status.sessionStart', null, true);
      await this.setStateSafe('charger.status.sessionDurationMin', null, true);
    }

    if (activeTransport === 'local') {
      await this.setStateSafe('charger.status.energyToday', null, true);
      await this.setStateSafe('charger.status.energyTotal', null, true);
      await this.setStateSafe('charger.status.accEnergy', null, true);
      await this.setStateSafe('charger.status.accEnergy2', null, true);
      await this.setStateSafe('charger.status.errorCode', null, true);
    }
  }

  enqueueSerialized(label, task, isWrite = false) {
    const run = async () => {
      if (isWrite) {
        const minGap = Math.max(0, asInteger(this.config.commandMinGapMs) || 0);
        const remaining = minGap - (Date.now() - this.lastWriteAt);
        if (remaining > 0) {
          await delay(remaining);
        }
      }

      const result = await task();

      if (isWrite) {
        this.lastWriteAt = Date.now();
      }

      return result;
    };

    const resultPromise = this.serialQueue.then(run, run);
    this.serialQueue = resultPromise.catch(() => undefined);
    return resultPromise;
  }

  async pollNow() {
    try {
      const snapshot = await this.enqueueSerialized('poll', async () => this.fetchSnapshot(), false);
      if (snapshot) {
        this.consecutivePollFailures = 0;
        await this.applySnapshot(snapshot);
      }
    } catch (error) {
      this.consecutivePollFailures += 1;
      await this.handleError(error, 'poll');

      if (
        normalizeTransport(this.config.transport) === 'auto'
        && this.activeTransport === 'local'
        && this.consecutivePollFailures >= (asInteger(this.config.failoverThreshold) || 3)
      ) {
        try {
          this.log.warn('Auto failover: switching from local to cloud');
          const snapshot = await this.enqueueSerialized('failover-cloud', () => this.activateCloudTransport(), false);
          this.consecutivePollFailures = 0;
          await this.applySnapshot(snapshot);
        } catch (failoverError) {
          await this.handleError(failoverError, 'failover');
        }
      }
    } finally {
      this.schedulePoll((asInteger(this.config.pollIntervalSec) || 10) * 1000);
    }
  }

  async fetchSnapshot() {
    if (this.activeTransport === 'local') {
      if (!this.localClient) {
        throw new Error('Local client is not initialized');
      }
      return this.localClient.readStatus();
    }

    if (this.activeTransport === 'cloud') {
      if (!this.cloudClient || !this.currentCloudDevice) {
        throw new Error('Cloud client is not initialized');
      }
      const latestDevice = await this.cloudClient.getDeviceById(String(this.currentCloudDevice.id));
      if (latestDevice) {
        this.currentCloudDevice = latestDevice;
      }
      return this.cloudClient.getSnapshot(
        String(this.currentCloudDevice.id),
        this.currentCloudDevice,
        this.config.requestChargeRecords !== false,
      );
    }

    const snapshot = await this.initializeTransport();
    return snapshot;
  }

  async applySnapshot(snapshot) {
    const online = snapshot.reportedOnline === null || snapshot.reportedOnline === undefined
      ? true
      : Boolean(snapshot.reportedOnline);

    await this.setStateSafe('info.connection', true, true);
    await this.setStateSafe('info.lastError', '', true);
    await this.setStateSafe('info.lastPoll', Date.now(), true);

    await this.setStateSafe('charger.info.host', snapshot.host || '', true);
    await this.setStateSafe('charger.info.deviceId', snapshot.deviceId || '', true);
    await this.setStateSafe('charger.info.name', snapshot.name || '', true);
    await this.setStateSafe('charger.info.model', snapshot.model || '', true);
    await this.setStateSafe('charger.info.manufacturer', snapshot.manufacturer || '', true);
    await this.setStateSafe('charger.info.firmware', snapshot.firmware || '', true);
    await this.setStateSafe('charger.info.serialNumber', snapshot.serialNumber || '', true);

    await this.setStateSafe('charger.status.online', online, true);
    await this.setStateSafe('charger.status.stateCode', snapshot.stateCode, true);
    await this.setStateSafe('charger.status.state', snapshot.state || '', true);
    await this.setStateSafe('charger.status.isCharging', Boolean(snapshot.isCharging), true);
    await this.setStateSafe('charger.status.error', Boolean(snapshot.errorCode && snapshot.errorCode !== 0), true);
    await this.setStateSafe('charger.status.errorCode', snapshot.errorCode, true);

    await this.setStateSafe('charger.status.voltage', snapshot.voltage, true);
    await this.setStateSafe('charger.status.voltageL2', snapshot.voltage2, true);
    await this.setStateSafe('charger.status.voltageL3', snapshot.voltage3, true);
    await this.setStateSafe('charger.status.current', snapshot.current, true);
    await this.setStateSafe('charger.status.currentL2', snapshot.current2, true);
    await this.setStateSafe('charger.status.currentL3', snapshot.current3, true);
    await this.setStateSafe('charger.status.power', snapshot.power, true);
    await this.setStateSafe('charger.status.temperature', snapshot.temperature, true);
    await this.setStateSafe('charger.status.temperatureInternal', snapshot.temperatureInternal, true);
    await this.setStateSafe('charger.status.cpVoltage', snapshot.cpVoltage, true);
    await this.setStateSafe('charger.status.sessionEnergy', snapshot.sessionEnergy, true);
    await this.setStateSafe('charger.status.sessionStart', snapshot.sessionStartTsMs, true);
    await this.setStateSafe('charger.status.sessionDurationMin', snapshot.sessionDurationMin, true);
    await this.setStateSafe('charger.status.energyToday', snapshot.energyToday, true);
    await this.setStateSafe('charger.status.energyTotal', snapshot.energyTotal, true);
    await this.setStateSafe('charger.status.accEnergy', snapshot.accEnergy, true);
    await this.setStateSafe('charger.status.accEnergy2', snapshot.accEnergy2, true);
    await this.setStateSafe('charger.status.maxCurrentReported', snapshot.maxCurrent, true);

    if (snapshot.maxCurrent !== null && snapshot.maxCurrent !== undefined) {
      await this.setShadowState('charger.control.maxCurrent', snapshot.maxCurrent);
    }
    if (snapshot.directWorkMode !== null && snapshot.directWorkMode !== undefined) {
      await this.setShadowState('charger.control.directWorkMode', snapshot.directWorkMode);
    }
    if (snapshot.levelDetection !== null && snapshot.levelDetection !== undefined) {
      await this.setShadowState('charger.control.levelDetection', snapshot.levelDetection);
    }
    if (snapshot.stopOnDisconnect !== null && snapshot.stopOnDisconnect !== undefined) {
      await this.setShadowState('charger.control.stopOnDisconnect', snapshot.stopOnDisconnect);
    }
    if (snapshot.ledBrightness !== null && snapshot.ledBrightness !== undefined) {
      await this.setShadowState('charger.control.ledBrightness', snapshot.ledBrightness);
    }
  }

  async setShadowState(id, value) {
    this.commandShadow.set(id, value);
    await this.setStateSafe(id, value, true);
  }

  async setStateSafe(id, value, ack) {
    let normalizedValue = value;

    if (typeof normalizedValue === 'number' && Number.isNaN(normalizedValue)) {
      normalizedValue = null;
    }

    await this.setStateChangedAsync(id, {
      val: normalizedValue,
      ack,
    });
  }

  async handleError(error, phase) {
    const message = error && error.message ? error.message : String(error);
    this.log.warn(`${phase}: ${message}`);
    await this.setStateSafe('info.connection', false, true);
    await this.setStateSafe('charger.status.online', false, true);
    await this.setStateSafe('info.lastError', `[${phase}] ${message}`, true);
  }

  async onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }

    const relativeId = id.replace(`${this.namespace}.`, '');

    if (relativeId === 'charger.control.refresh') {
      await this.ackButton(relativeId);
      this.scheduleFastPoll(50);
      return;
    }

    if (relativeId === 'charger.control.start') {
      await this.runButtonCommand(relativeId, () => this.startCharging());
      return;
    }

    if (relativeId === 'charger.control.stop') {
      await this.runButtonCommand(relativeId, () => this.stopCharging());
      return;
    }

    if (relativeId === 'charger.control.maxCurrent') {
      const requested = asInteger(state.val);
      const previous = this.commandShadow.get(relativeId);
      await this.scheduleMaxCurrentWrite(relativeId, requested, previous);
      return;
    }

    if (relativeId === 'charger.control.directWorkMode') {
      const requested = asBoolean(state.val);
      await this.runStateCommand(relativeId, requested, previousValue => this.setDirectWorkMode(previousValue));
      return;
    }

    if (relativeId === 'charger.control.levelDetection') {
      const requested = asBoolean(state.val);
      await this.runStateCommand(relativeId, requested, previousValue => this.setLevelDetection(previousValue));
      return;
    }

    if (relativeId === 'charger.control.stopOnDisconnect') {
      const requested = asBoolean(state.val);
      await this.runStateCommand(relativeId, requested, previousValue => this.setStopOnDisconnect(previousValue));
      return;
    }

    if (relativeId === 'charger.control.ledBrightness') {
      const requested = asInteger(state.val);
      await this.runStateCommand(relativeId, requested, previousValue => this.setLedBrightness(previousValue));
    }
  }

  async ackButton(relativeId) {
    const fullId = relativeId.startsWith(this.namespace) ? relativeId : relativeId;
    await this.setStateSafe(fullId, true, true);
    await delay(50);
    await this.setStateSafe(fullId, false, true);
  }

  async runButtonCommand(relativeId, command) {
    try {
      await this.enqueueSerialized(relativeId, async () => {
        await command();
        return true;
      }, true);
    } catch (error) {
      await this.handleError(error, relativeId);
    } finally {
      await this.ackButton(relativeId);
      this.scheduleFastPoll();
    }
  }

  async scheduleMaxCurrentWrite(relativeId, requestedValue, previousValue) {
    if (requestedValue === null) {
      await this.setStateSafe(relativeId, previousValue ?? null, true);
      return;
    }

    this.pendingMaxCurrent = {
      relativeId,
      value: requestedValue,
      previousValue,
    };

    if (this.maxCurrentTimer) {
      clearTimeout(this.maxCurrentTimer);
    }

    const debounceMs = Math.max(0, asInteger(this.config.commandDebounceMs) || 0);
    this.maxCurrentTimer = setTimeout(() => {
      this.maxCurrentTimer = null;
      const pending = this.pendingMaxCurrent;
      this.pendingMaxCurrent = null;
      if (!pending) {
        return;
      }
      void this.runStateCommand(
        pending.relativeId,
        pending.value,
        value => this.setMaxCurrent(value),
        pending.previousValue,
      );
    }, debounceMs);
  }

  async runStateCommand(relativeId, requestedValue, command, explicitPreviousValue = undefined) {
    const previousValue = explicitPreviousValue !== undefined
      ? explicitPreviousValue
      : this.commandShadow.get(relativeId);

    try {
      await this.enqueueSerialized(relativeId, async () => {
        await command(requestedValue);
        return true;
      }, true);
      await this.setShadowState(relativeId, requestedValue);
      this.scheduleFastPoll();
    } catch (error) {
      await this.handleError(error, relativeId);
      await this.setStateSafe(relativeId, previousValue ?? null, true);
    }
  }

  async setMaxCurrent(value) {
    if (value === null || value === undefined) {
      throw new Error('Max current cannot be empty');
    }

    if (this.activeTransport === 'local') {
      if (!this.localClient) {
        throw new Error('Local client is not initialized');
      }
      return this.localClient.setMaxCurrent(value);
    }

    if (this.activeTransport === 'cloud') {
      if (!this.cloudClient || !this.currentCloudDevice) {
        throw new Error('Cloud client is not initialized');
      }
      return this.cloudClient.setMaxCurrent(String(this.currentCloudDevice.id), value);
    }

    throw new Error('No active transport for setMaxCurrent');
  }

  async setDirectWorkMode(value) {
    if (value === null) {
      throw new Error('Direct work mode must be boolean');
    }

    if (this.activeTransport === 'local') {
      if (!this.localClient) {
        throw new Error('Local client is not initialized');
      }
      return this.localClient.setDirectWorkMode(value);
    }

    if (this.activeTransport === 'cloud') {
      if (!this.cloudClient || !this.currentCloudDevice) {
        throw new Error('Cloud client is not initialized');
      }
      return this.cloudClient.setDirectWorkMode(String(this.currentCloudDevice.id), value);
    }

    throw new Error('No active transport for setDirectWorkMode');
  }

  async setLevelDetection(value) {
    if (value === null) {
      throw new Error('Level detection must be boolean');
    }

    if (this.activeTransport === 'local') {
      if (!this.localClient) {
        throw new Error('Local client is not initialized');
      }
      return this.localClient.setLevelDetection(value);
    }

    if (this.activeTransport === 'cloud') {
      if (!this.cloudClient || !this.currentCloudDevice) {
        throw new Error('Cloud client is not initialized');
      }
      return this.cloudClient.setLevelDetection(String(this.currentCloudDevice.id), value);
    }

    throw new Error('No active transport for setLevelDetection');
  }

  async setStopOnDisconnect(value) {
    if (value === null) {
      throw new Error('Stop on disconnect must be boolean');
    }

    if (this.activeTransport === 'local') {
      if (!this.localClient) {
        throw new Error('Local client is not initialized');
      }
      return this.localClient.setStopOnDisconnect(value);
    }

    if (this.activeTransport === 'cloud') {
      if (!this.cloudClient || !this.currentCloudDevice) {
        throw new Error('Cloud client is not initialized');
      }
      return this.cloudClient.setStopOnDisconnect(String(this.currentCloudDevice.id), value);
    }

    throw new Error('No active transport for setStopOnDisconnect');
  }

  async setLedBrightness(value) {
    if (value === null || value === undefined) {
      throw new Error('LED brightness cannot be empty');
    }

    if (this.activeTransport === 'local') {
      if (!this.localClient) {
        throw new Error('Local client is not initialized');
      }
      return this.localClient.setLedBrightness(value);
    }

    if (this.activeTransport === 'cloud') {
      if (!this.cloudClient || !this.currentCloudDevice) {
        throw new Error('Cloud client is not initialized');
      }
      return this.cloudClient.setLedBrightness(String(this.currentCloudDevice.id), value);
    }

    throw new Error('No active transport for setLedBrightness');
  }

  async startCharging() {
    if (this.activeTransport === 'local') {
      if (!this.localClient) {
        throw new Error('Local client is not initialized');
      }
      return this.localClient.startCharging();
    }

    if (this.activeTransport === 'cloud') {
      if (!this.cloudClient || !this.currentCloudDevice) {
        throw new Error('Cloud client is not initialized');
      }
      return this.cloudClient.startCharging(String(this.currentCloudDevice.id));
    }

    throw new Error('No active transport for startCharging');
  }

  async stopCharging() {
    if (this.activeTransport === 'local') {
      if (!this.localClient) {
        throw new Error('Local client is not initialized');
      }
      return this.localClient.stopCharging();
    }

    if (this.activeTransport === 'cloud') {
      if (!this.cloudClient || !this.currentCloudDevice) {
        throw new Error('Cloud client is not initialized');
      }
      return this.cloudClient.stopCharging(String(this.currentCloudDevice.id));
    }

    throw new Error('No active transport for stopCharging');
  }
}

if (module && module.parent) {
  module.exports = options => new Duosidaems(options);
} else {
  (() => new Duosidaems())();
}
