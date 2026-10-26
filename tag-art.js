'use strict';

// Embedded cover art extraction without third-party dependencies.
// Supports ID3v2 (MP3), FLAC PICTURE blocks, Ogg Vorbis/Opus
// METADATA_BLOCK_PICTURE, MP4/M4A `covr` atoms and RIFF/WAV `id3 ` chunks.

const fs = require('fs');

const MAX_READ_BYTES = 160 * 1024 * 1024;

const IMAGE_MAGIC = [
  { mime: 'image/jpeg', ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/gif', ext: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] },
  { mime: 'image/bmp', ext: 'bmp', bytes: [0x42, 0x4d] }
];

function sniffImage(buf) {
  if (!buf || buf.length < 8) return null;
  for (const entry of IMAGE_MAGIC) {
    let hit = true;
    for (let i = 0; i < entry.bytes.length; i++) {
      if (buf[i] !== entry.bytes[i]) { hit = false; break; }
    }
    if (hit) {
      if (entry.mime === 'image/webp' && buf.length >= 12) {
        if (buf.toString('ascii', 8, 12) !== 'WEBP') continue;
      }
      return entry;
    }
  }
  return null;
}

function syncSafeToInt(buf, offset) {
  return ((buf[offset] & 0x7f) << 21) | ((buf[offset + 1] & 0x7f) << 14) | ((buf[offset + 2] & 0x7f) << 7) | (buf[offset + 3] & 0x7f);
}

function removeUnsync(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let w = 0;
  for (let i = 0; i < buf.length; i++) {
    out[w++] = buf[i];
    if (buf[i] === 0xff && buf[i + 1] === 0x00) i++;
  }
  return out.subarray(0, w);
}

// ---- ID3v2 (MP3, also used by WAV `id3 ` chunks) ----

function readId3v2Frames(buf, start) {
  if (buf.length < start + 10) return null;
  if (buf.toString('ascii', start, start + 3) !== 'ID3') return null;
  const major = buf[start + 3];
  const flags = buf[start + 5];
  const size = syncSafeToInt(buf, start + 6);
  const tagEnd = Math.min(buf.length, start + 10 + size);
  let body = buf.subarray(start + 10, tagEnd);
  if (flags & 0x80) body = removeUnsync(body);

  let offset = 0;
  if (major >= 3 && (flags & 0x40)) {
    // Extended header: size field width differs between 2.3 and 2.4.
    if (major === 3) offset = 4 + body.readUInt32BE(0);
    else offset = syncSafeToInt(body, 0);
  }

  const pictures = [];
  const idLen = major === 2 ? 3 : 4;
  const headerLen = major === 2 ? 6 : 10;

  while (offset + headerLen <= body.length) {
    const id = body.toString('ascii', offset, offset + idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    let frameSize;
    if (major === 2) {
      frameSize = (body[offset + 3] << 16) | (body[offset + 4] << 8) | body[offset + 5];
    } else if (major === 4) {
      frameSize = syncSafeToInt(body, offset + 4);
    } else {
      frameSize = body.readUInt32BE(offset + 4);
    }
    if (frameSize <= 0 || offset + headerLen + frameSize > body.length) break;
    const frame = body.subarray(offset + headerLen, offset + headerLen + frameSize);
    offset += headerLen + frameSize;

    if (id === 'APIC' || id === 'PIC') {
      try {
        const enc = frame[0];
        let p = 1;
        if (id === 'PIC') {
          p += 3; // 3-char image format
        } else {
          while (p < frame.length && frame[p] !== 0) p++;
          p++; // mime terminator
        }
        p += 1; // picture type
        if (enc === 1 || enc === 2) {
          while (p + 1 < frame.length && !(frame[p] === 0 && frame[p + 1] === 0)) p += 2;
          p += 2;
        } else {
          while (p < frame.length && frame[p] !== 0) p++;
          p++;
        }
        if (p < frame.length) pictures.push(frame.subarray(p));
      } catch (e) {}
    }
  }
  return pictures;
}

// ---- FLAC ----

function parseFlacPicture(block) {
  try {
    let p = 0;
    p += 4; // picture type
    const mimeLen = block.readUInt32BE(p); p += 4;
    p += mimeLen;
    const descLen = block.readUInt32BE(p); p += 4;
    p += descLen;
    p += 16; // width, height, depth, colors
    const dataLen = block.readUInt32BE(p); p += 4;
    if (dataLen <= 0 || p + dataLen > block.length) return null;
    return block.subarray(p, p + dataLen);
  } catch (e) {
    return null;
  }
}

function readFlacArt(buf) {
  if (buf.length < 8 || buf.toString('ascii', 0, 4) !== 'fLaC') return null;
  let offset = 4;
  while (offset + 4 <= buf.length) {
    const header = buf[offset];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
    const start = offset + 4;
    if (start + length > buf.length) break;
    if (type === 6) {
      const art = parseFlacPicture(buf.subarray(start, start + length));
      if (art) return art;
    }
    offset = start + length;
    if (isLast) break;
  }
  return null;
}

// ---- Ogg Vorbis / Opus ----

function readOggArt(buf) {
  let offset = 0;
  let packet = [];
  let packetsSeen = 0;
  while (offset + 27 <= buf.length) {
    if (buf.toString('ascii', offset, offset + 4) !== 'OggS') break;
    const segCount = buf[offset + 26];
    const tableStart = offset + 27;
    if (tableStart + segCount > buf.length) break;
    let dataStart = tableStart + segCount;
    let total = 0;
    for (let i = 0; i < segCount; i++) total += buf[tableStart + i];
    if (dataStart + total > buf.length) break;

    let cursor = dataStart;
    for (let i = 0; i < segCount; i++) {
      const seg = buf[tableStart + i];
      packet.push(buf.subarray(cursor, cursor + seg));
      cursor += seg;
      if (seg < 255) {
        packetsSeen++;
        if (packetsSeen <= 2) {
          const joined = Buffer.concat(packet);
          const art = extractVorbisPicture(joined);
          if (art) return art;
        }
        packet = [];
        if (packetsSeen > 2) return null;
      }
    }
    offset = dataStart + total;
  }
  return null;
}

function extractVorbisPicture(packet) {
  const idx = packet.indexOf('METADATA_BLOCK_PICTURE=');
  if (idx === -1) return null;
  let end = packet.indexOf(0x00, idx);
  if (end === -1) end = packet.length;
  const b64 = packet.toString('ascii', idx + 'METADATA_BLOCK_PICTURE='.length, end);
  try {
    return parseFlacPicture(Buffer.from(b64, 'base64'));
  } catch (e) {
    return null;
  }
}

// ---- MP4 / M4A ----

function readMp4Art(buf) {
  const containers = new Set(['moov', 'udta', 'trak', 'mdia', 'minf', 'stbl', 'meta', 'ilst']);
  let found = null;

  function walk(start, end, depth) {
    let offset = start;
    while (offset + 8 <= end && !found) {
      let size = buf.readUInt32BE(offset);
      const type = buf.toString('ascii', offset + 4, offset + 8);
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > end) return;
        size = Number(buf.readBigUInt64BE(offset + 8));
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < headerSize || offset + size > end) return;
      const bodyStart = offset + headerSize;
      const bodyEnd = offset + size;

      if (type === 'covr') {
        found = readCovr(buf, bodyStart, bodyEnd);
        if (found) return;
      } else if (containers.has(type) && depth < 8) {
        // `meta` has a 4-byte version/flags field before its children.
        walk(bodyStart + (type === 'meta' ? 4 : 0), bodyEnd, depth + 1);
      }
      offset = bodyEnd;
    }
  }

  walk(0, buf.length, 0);
  return found;
}

function readCovr(buf, start, end) {
  let offset = start;
  while (offset + 8 <= end) {
    const size = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (size < 8 || offset + size > end) break;
    if (type === 'data' && offset + 16 <= end) {
      const payload = buf.subarray(offset + 16, offset + size);
      if (sniffImage(payload)) return payload;
    }
    offset += size;
  }
  return null;
}

// ---- RIFF / WAV ----

function readWavArt(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buf.length) break;
    if (id === 'id3 ' || id === 'ID3 ') {
      const frames = readId3v2Frames(buf, start);
      if (frames && frames.length) return frames[0];
    }
    offset = start + size + (size % 2);
  }
  return null;
}

function extractFromBuffer(buf) {
  const candidates = [readId3v2Frames, readFlacArt, readOggArt, readMp4Art, readWavArt];
  for (const reader of candidates) {
    try {
      const result = reader(buf, 0);
      if (Array.isArray(result) && result.length) return result[0];
      if (Buffer.isBuffer(result) && result.length) return result;
    } catch (e) {}
  }
  return null;
}

function readFileLimited(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_READ_BYTES) return null;
  return fs.readFileSync(file);
}

/**
 * Returns { data: Buffer, mime: string, ext: string } or null.
 */
function extractEmbeddedArt(file) {
  let buf;
  try {
    buf = readFileLimited(file);
  } catch (e) {
    return null;
  }
  if (!buf) return null;
  const data = extractFromBuffer(buf);
  if (!data) return null;
  const kind = sniffImage(data) || { mime: 'image/jpeg', ext: 'jpg' };
  return { data, mime: kind.mime, ext: kind.ext };
}

module.exports = { extractEmbeddedArt, sniffImage };
