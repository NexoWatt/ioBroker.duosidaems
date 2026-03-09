'use strict';

const dgram = require('node:dgram');
const os = require('node:os');

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
    source: 'udp-broadcast',
  };
}

function normalizeIpv4Family(family) {
  return family === 'IPv4' || family === 4;
}

function ipv4ToInt(ip) {
  const parts = String(ip || '').trim().split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }

  return (((parts[0] << 24) >>> 0)
    + ((parts[1] << 16) >>> 0)
    + ((parts[2] << 8) >>> 0)
    + (parts[3] >>> 0)) >>> 0;
}

function intToIpv4(value) {
  const normalized = Number(value) >>> 0;
  return [
    (normalized >>> 24) & 255,
    (normalized >>> 16) & 255,
    (normalized >>> 8) & 255,
    normalized & 255,
  ].join('.');
}

function sortByIpAddress(a, b) {
  const left = ipv4ToInt(a.ip || a);
  const right = ipv4ToInt(b.ip || b);
  if (left === null && right === null) {
    return String(a.ip || a).localeCompare(String(b.ip || b));
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left - right;
}

function getCandidateHostsForInterface(interfaceDetails, maxHosts) {
  const addressInt = ipv4ToInt(interfaceDetails.address);
  const netmaskInt = ipv4ToInt(interfaceDetails.netmask);

  if (addressInt === null || netmaskInt === null) {
    return [];
  }

  const networkInt = addressInt & netmaskInt;
  const broadcastInt = (networkInt | (~netmaskInt >>> 0)) >>> 0;
  const firstHost = networkInt + 1;
  const lastHost = broadcastInt - 1;

  if (lastHost < firstHost) {
    return [];
  }

  let start = firstHost;
  let end = lastHost;
  const hostCount = end - start + 1;

  if (hostCount > maxHosts) {
    const halfWindow = Math.floor(maxHosts / 2);
    start = Math.max(firstHost, addressInt - halfWindow);
    end = Math.min(lastHost, start + maxHosts - 1);
    start = Math.max(firstHost, end - maxHosts + 1);
  }

  const candidates = [];
  for (let current = start; current <= end; current += 1) {
    if (current === addressInt) {
      continue;
    }
    candidates.push(intToIpv4(current));
  }

  return candidates;
}

function getSubnetScanCandidates(options = {}) {
  const requestedInterface = String(options.interfaceAddress || '').trim();
  const maxHosts = Math.max(16, Number(options.subnetMaxHosts) || 256);
  const interfaces = os.networkInterfaces();
  const result = new Set();

  for (const detailsList of Object.values(interfaces)) {
    for (const details of detailsList || []) {
      if (!details || !normalizeIpv4Family(details.family) || details.internal) {
        continue;
      }

      if (requestedInterface && requestedInterface !== '0.0.0.0' && requestedInterface !== details.address) {
        continue;
      }

      for (const candidate of getCandidateHostsForInterface(details, maxHosts)) {
        result.add(candidate);
      }
    }
  }

  return Array.from(result).sort(sortByIpAddress);
}

async function mapLimit(items, limit, mapper) {
  const normalizedLimit = Math.max(1, Number(limit) || 1);
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(normalizedLimit, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }

      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

async function scanSubnetForChargers(options = {}) {
  const logger = options.logger || console;
  const candidates = getSubnetScanCandidates(options);
  if (!candidates.length) {
    return [];
  }

  logger.debug(`Subnet scan will probe ${candidates.length} host(s) on TCP ${options.port || 9988}`);

  const timeoutMs = Math.max(500, Number(options.subnetTimeoutMs) || 1200);
  const concurrency = Math.max(1, Number(options.subnetConcurrency) || 32);

  const results = await mapLimit(candidates, concurrency, async ip => {
    try {
      const deviceId = await getDeviceIdViaTcp(ip, {
        port: options.port || 9988,
        timeoutMs,
        logger,
      });

      if (!deviceId) {
        return null;
      }

      return {
        ip,
        mac: '',
        type: 'tcp-scan',
        firmware: '',
        deviceId,
        raw: `tcp-scan:${ip}`,
        source: 'tcp-subnet-scan',
      };
    } catch {
      return null;
    }
  });

  return results.filter(Boolean).sort(sortByIpAddress);
}

function mergeDevices(primary, secondary) {
  const devicesByIp = new Map();

  for (const device of [...primary, ...secondary]) {
    if (!device || !device.ip) {
      continue;
    }

    if (!devicesByIp.has(device.ip)) {
      devicesByIp.set(device.ip, device);
      continue;
    }

    const existing = devicesByIp.get(device.ip);
    devicesByIp.set(device.ip, {
      ...existing,
      ...device,
      mac: existing.mac || device.mac || '',
      type: existing.type || device.type || '',
      firmware: existing.firmware || device.firmware || '',
      deviceId: existing.deviceId || device.deviceId || null,
      raw: existing.raw || device.raw || '',
      source: existing.source || device.source || '',
    });
  }

  return Array.from(devicesByIp.values()).sort(sortByIpAddress);
}

async function discoverViaUdp(options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 5000);
  const interfaceAddress = options.interfaceAddress || '0.0.0.0';
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

  return Array.from(devicesByIp.values()).sort(sortByIpAddress);
}

async function attachDeviceIds(devices, options = {}) {
  if (!devices.length || options.includeDeviceId === false) {
    return devices;
  }

  const logger = options.logger || console;

  for (const device of devices) {
    if (device.deviceId) {
      continue;
    }

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

async function discoverChargers(options = {}) {
  const logger = options.logger || console;

  let udpDevices = [];
  try {
    udpDevices = await discoverViaUdp(options);
  } catch (error) {
    logger.warn(`UDP discovery failed: ${error.message}`);
  }

  udpDevices = await attachDeviceIds(udpDevices, options);

  if (udpDevices.length || options.subnetFallback === false) {
    return udpDevices;
  }

  logger.debug('UDP discovery returned no results. Falling back to local subnet TCP scan.');
  const tcpDevices = await scanSubnetForChargers(options);
  return mergeDevices(udpDevices, tcpDevices);
}

module.exports = {
  DISCOVERY_SOURCE_PORT,
  DISCOVERY_TARGET_PORT,
  DISCOVERY_PAYLOAD,
  getSubnetScanCandidates,
  parseDiscoveryResponse,
  discoverChargers,
};
