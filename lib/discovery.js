'use strict';

const dgram = require('node:dgram');

const { getDeviceIdViaTcp } = require('./localClient');

const DISCOVERY_SOURCE_PORT = 48890;
const DISCOVERY_TARGET_PORT = 48899;
const DISCOVERY_PAYLOAD = Buffer.from('smart_chargepile_search\x00', 'utf8');

function parseDiscoveryResponse(buffer) {
  const decoded = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const cleaned = decoded.replace(/\u0000+$/g, '').trim();
  const parts = cleaned.split(',');
  if (parts.length < 4) {
    return null;
  }

  return {
    ip: parts[0] || '',
    mac: parts[1] || '',
    type: parts[2] || '',
    firmware: parts[3] || '',
    deviceId: null,
    raw: cleaned,
  };
}

async function discoverChargers(options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 5000);
  const interfaceAddress = options.interfaceAddress || '0.0.0.0';
  const includeDeviceId = options.includeDeviceId !== false;
  const logger = options.logger || console;

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const devicesByIp = new Map();

  await new Promise((resolve, reject) => {
    const onError = error => {
      socket.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      socket.removeListener('error', onError);
      resolve();
    };

    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind({ address: interfaceAddress, port: DISCOVERY_SOURCE_PORT, exclusive: false });
  });

  socket.setBroadcast(true);

  socket.on('message', message => {
    try {
      const device = parseDiscoveryResponse(message);
      if (!device || !device.ip) {
        return;
      }
      if (!devicesByIp.has(device.ip)) {
        devicesByIp.set(device.ip, device);
      }
    } catch (error) {
      logger.debug(`Failed to parse discovery response: ${error.message}`);
    }
  });

  await new Promise((resolve, reject) => {
    socket.send(DISCOVERY_PAYLOAD, DISCOVERY_TARGET_PORT, '255.255.255.255', error => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

  await new Promise(resolve => setTimeout(resolve, timeoutMs));
  socket.close();

  const devices = Array.from(devicesByIp.values());
  if (!includeDeviceId) {
    return devices;
  }

  for (const device of devices) {
    try {
      device.deviceId = await getDeviceIdViaTcp(device.ip, {
        port: options.port || 9988,
        timeoutMs: options.timeoutMs || 3000,
        logger,
      });
    } catch {
      device.deviceId = null;
    }
  }

  return devices;
}

module.exports = {
  DISCOVERY_SOURCE_PORT,
  DISCOVERY_TARGET_PORT,
  DISCOVERY_PAYLOAD,
  parseDiscoveryResponse,
  discoverChargers,
};
