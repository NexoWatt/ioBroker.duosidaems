'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  encodeVarint,
  encodeString,
  encodeVarintField,
  encodeEmbeddedMessage,
  decodeVarint,
  decodeMessage,
  maybeDecodeUtf8,
} = require('../lib/protobuf');
const { parseDiscoveryResponse } = require('../lib/discovery');
const { extractDeviceIdFromHandshakeFrame } = require('../lib/localClient');
const { summarizeChargeRecords } = require('../lib/cloudClient');

test('encode/decode varint roundtrip', () => {
  const encoded = encodeVarint(300);
  const decoded = decodeVarint(encoded, 0);
  assert.equal(decoded.value, 300);
  assert.equal(decoded.offset, encoded.length);
});

test('embedded protobuf message roundtrip', () => {
  const inner = Buffer.concat([
    encodeString(1, 'VendorMaxWorkCurrent'),
    encodeString(2, '16'),
  ]);
  const outer = Buffer.concat([
    encodeEmbeddedMessage(10, inner),
    encodeVarintField(101, 3),
  ]);

  const decodedOuter = decodeMessage(outer);
  assert.ok(Buffer.isBuffer(decodedOuter[10]));
  assert.equal(decodedOuter[101], 3);

  const decodedInner = decodeMessage(decodedOuter[10]);
  assert.equal(maybeDecodeUtf8(decodedInner[1]), 'VendorMaxWorkCurrent');
  assert.equal(maybeDecodeUtf8(decodedInner[2]), '16');
});

test('discovery response parser', () => {
  const parsed = parseDiscoveryResponse(Buffer.from('192.168.1.50,AA:BB:CC:DD:EE:FF,smart_wifi,1.0.0\x00'));
  assert.deepEqual(parsed, {
    ip: '192.168.1.50',
    mac: 'AA:BB:CC:DD:EE:FF',
    type: 'smart_wifi',
    firmware: '1.0.0',
    deviceId: null,
    raw: '192.168.1.50,AA:BB:CC:DD:EE:FF,smart_wifi,1.0.0',
  });
});

test('device id extraction from handshake frame', () => {
  const frame = Buffer.from('something 0312345678901234567 else', 'utf8');
  assert.equal(extractDeviceIdFromHandshakeFrame(frame), '0312345678901234567');
});

test('charge record summary', () => {
  const now = new Date('2026-03-08T12:00:00');
  const records = {
    chartList: [
      { timestampStop: new Date('2026-03-08T08:00:00').getTime(), energy: 4.25 },
      { timestampStop: new Date('2026-03-07T08:00:00').getTime(), energy: 5.50 },
    ],
  };

  const summary = summarizeChargeRecords(records, now);
  assert.equal(summary.todayConsumption, 4.25);
  assert.equal(summary.totalConsumption, 9.75);
});
