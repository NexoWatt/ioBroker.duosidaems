'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { LocalClient, HANDSHAKE_1 } = require('../lib/localClient');

test('LocalClient accepts a status frame that already arrives after the first handshake packet', async () => {
  const client = new LocalClient({
    host: '192.168.1.10',
    timeoutMs: 1000,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });

  const writes = [];
  const fakeSession = {
    async write(buffer) {
      writes.push(Buffer.from(buffer));
    },
    async nextChunk() {
      return Buffer.from('status-first-handshake', 'utf8');
    },
    drainQueue() {
      return [];
    },
  };

  client._withSession = async callback => callback(fakeSession);
  client._parseStatusFrame = chunk => {
    if (chunk.toString('utf8') === 'status-first-handshake') {
      return {
        transport: 'local',
        host: '192.168.1.10',
        deviceId: '0312345678901234567',
        stateCode: 2,
        state: 'Charging',
        isCharging: true,
      };
    }
    return null;
  };

  const snapshot = await client.readStatus(5, 1);

  assert.equal(snapshot.deviceId, '0312345678901234567');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], HANDSHAKE_1);
  assert.equal(client.deviceId, '0312345678901234567');
});
