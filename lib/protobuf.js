'use strict';

function encodeVarint(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new Error(`Varint value must be a non-negative integer, got: ${value}`);
  }

  const bytes = [];
  let remaining = numeric;
  while (remaining > 0x7F) {
    bytes.push((remaining & 0x7F) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining & 0x7F);
  return Buffer.from(bytes);
}

function encodeString(fieldNumber, value) {
  const data = Buffer.from(String(value), 'utf8');
  const fieldHeader = encodeVarint((fieldNumber << 3) | 2);
  const length = encodeVarint(data.length);
  return Buffer.concat([fieldHeader, length, data]);
}

function encodeFloat(fieldNumber, value) {
  const fieldHeader = encodeVarint((fieldNumber << 3) | 5);
  const data = Buffer.allocUnsafe(4);
  data.writeFloatLE(Number(value), 0);
  return Buffer.concat([fieldHeader, data]);
}

function encodeVarintField(fieldNumber, value) {
  const fieldHeader = encodeVarint((fieldNumber << 3) | 0);
  const data = encodeVarint(value);
  return Buffer.concat([fieldHeader, data]);
}

function encodeEmbeddedMessage(fieldNumber, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const fieldHeader = encodeVarint((fieldNumber << 3) | 2);
  const length = encodeVarint(payload.length);
  return Buffer.concat([fieldHeader, length, payload]);
}

function decodeVarint(buffer, startOffset = 0) {
  let result = 0;
  let shift = 0;
  let offset = startOffset;

  while (offset < buffer.length) {
    const byte = buffer[offset];
    result |= (byte & 0x7F) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) {
      return { value: result, offset };
    }
    shift += 7;
  }

  throw new Error('Unexpected end of buffer while decoding varint');
}

function decodeMessage(buffer) {
  const fields = {};
  let offset = 0;

  while (offset < buffer.length) {
    const keyInfo = decodeVarint(buffer, offset);
    const key = keyInfo.value;
    offset = keyInfo.offset;

    const fieldNumber = key >> 3;
    const wireType = key & 0x07;

    if (wireType === 0) {
      const valueInfo = decodeVarint(buffer, offset);
      fields[fieldNumber] = valueInfo.value;
      offset = valueInfo.offset;
      continue;
    }

    if (wireType === 1) {
      if (offset + 8 > buffer.length) {
        break;
      }
      fields[fieldNumber] = buffer.readDoubleLE(offset);
      offset += 8;
      continue;
    }

    if (wireType === 2) {
      const lengthInfo = decodeVarint(buffer, offset);
      const length = lengthInfo.value;
      offset = lengthInfo.offset;
      if (offset + length > buffer.length) {
        break;
      }
      fields[fieldNumber] = buffer.subarray(offset, offset + length);
      offset += length;
      continue;
    }

    if (wireType === 5) {
      if (offset + 4 > buffer.length) {
        break;
      }
      fields[fieldNumber] = buffer.readFloatLE(offset);
      offset += 4;
      continue;
    }

    // Unsupported wire type; stop parsing to avoid desynchronization.
    break;
  }

  return fields;
}

function maybeDecodeUtf8(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  return String(value);
}

module.exports = {
  encodeVarint,
  encodeString,
  encodeFloat,
  encodeVarintField,
  encodeEmbeddedMessage,
  decodeVarint,
  decodeMessage,
  maybeDecodeUtf8,
};
