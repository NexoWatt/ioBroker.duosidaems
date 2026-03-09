'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { getSubnetScanCandidates, parseDiscoveryResponse } = require('../lib/discovery');

test('parseDiscoveryResponse decodes Duosida UDP payload', () => {
  const payload = Buffer.from('192.168.1.55,AA:BB:CC:DD:EE:FF,SmartCharge,1.0.5\u0000', 'utf8');
  const parsed = parseDiscoveryResponse(payload);

  assert.equal(parsed.ip, '192.168.1.55');
  assert.equal(parsed.mac, 'AA:BB:CC:DD:EE:FF');
  assert.equal(parsed.type, 'SmartCharge');
  assert.equal(parsed.firmware, '1.0.5');
  assert.equal(parsed.source, 'udp-broadcast');
});

test('getSubnetScanCandidates returns a bounded host window around the local address', () => {
  const originalNetworkInterfaces = os.networkInterfaces;
  os.networkInterfaces = () => ({
    eth0: [
      {
        address: '192.168.1.100',
        netmask: '255.255.255.0',
        family: 'IPv4',
        internal: false,
      },
    ],
  });

  try {
    const candidates = getSubnetScanCandidates({ subnetMaxHosts: 16 });
    assert.equal(candidates.length, 15);
    assert.ok(!candidates.includes('192.168.1.100'));
    assert.equal(candidates[0], '192.168.1.92');
    assert.equal(candidates[candidates.length - 1], '192.168.1.107');
  } finally {
    os.networkInterfaces = originalNetworkInterfaces;
  }
});
