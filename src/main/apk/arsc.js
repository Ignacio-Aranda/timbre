'use strict';

// Compact reader for Android resources.arsc. It extracts the value of
// string resources by name (e.g. "google_api_key"), which is where Firebase
// keeps its configuration. Format reference:
// https://android.googlesource.com/platform/frameworks/base/+/master/libs/androidfw/include/androidfw/ResourceTypes.h

const RES_STRING_POOL_TYPE = 0x0001;
const RES_TABLE_TYPE = 0x0002;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;

const UTF8_FLAG = 1 << 8;

const ENTRY_FLAG_COMPLEX = 0x0001;
const TYPE_FLAG_SPARSE = 0x01;
const TYPE_FLAG_OFFSET16 = 0x02;

const DATA_TYPE_STRING = 0x03;
const NO_ENTRY = 0xffffffff;

function readLen8(buf, pos) {
  let len = buf[pos++];
  if (len & 0x80) len = ((len & 0x7f) << 8) | buf[pos++];
  return { len, pos };
}

function readLen16(buf, pos) {
  let len = buf.readUInt16LE(pos);
  pos += 2;
  if (len & 0x8000) {
    len = ((len & 0x7fff) << 16) | buf.readUInt16LE(pos);
    pos += 2;
  }
  return { len, pos };
}

// Parses a string pool chunk that starts at `off`. Returns the array of strings.
function parseStringPool(buf, off) {
  const flags = buf.readUInt32LE(off + 16);
  const stringCount = buf.readUInt32LE(off + 8);
  const stringsStart = buf.readUInt32LE(off + 20);
  const isUtf8 = (flags & UTF8_FLAG) !== 0;
  const strings = new Array(stringCount);
  const offsetsBase = off + 28;
  const dataBase = off + stringsStart;
  for (let i = 0; i < stringCount; i++) {
    const strOff = dataBase + buf.readUInt32LE(offsetsBase + i * 4);
    if (isUtf8) {
      let r = readLen8(buf, strOff); // utf16 length (chars)
      r = readLen8(buf, r.pos); // utf8 length (bytes)
      strings[i] = buf.toString('utf8', r.pos, r.pos + r.len);
    } else {
      const r = readLen16(buf, strOff);
      strings[i] = buf.toString('utf16le', r.pos, r.pos + r.len * 2);
    }
  }
  return strings;
}

// Returns a Map of string-resource-name -> value for every package in the file.
function readStringResources(buf) {
  if (buf.readUInt16LE(0) !== RES_TABLE_TYPE) {
    throw new Error('resources.arsc: cabecera no reconocida');
  }
  const result = new Map();

  // The global value string pool follows the table header.
  const tableHeaderSize = buf.readUInt16LE(2);
  let cursor = tableHeaderSize;
  if (buf.readUInt16LE(cursor) !== RES_STRING_POOL_TYPE) {
    throw new Error('resources.arsc: falta el string pool global');
  }
  const globalPoolSize = buf.readUInt32LE(cursor + 4);
  const globalStrings = parseStringPool(buf, cursor);
  cursor += globalPoolSize;

  // Then one or more package chunks.
  while (cursor + 8 <= buf.length) {
    const chunkType = buf.readUInt16LE(cursor);
    const chunkSize = buf.readUInt32LE(cursor + 4);
    if (chunkSize <= 0) break;
    if (chunkType === RES_TABLE_PACKAGE_TYPE) {
      parsePackage(buf, cursor, chunkSize, globalStrings, result);
    }
    cursor += chunkSize;
  }
  return result;
}

function parsePackage(buf, pkgOff, pkgSize, globalStrings, result) {
  // Package header: type(2) size(2) chunkSize(4) id(4) name[128*u16]=256
  // then typeStrings(4) @268, lastPublicType(4), keyStrings(4) @276.
  const keyStringsOff = buf.readUInt32LE(pkgOff + 276);
  if (!keyStringsOff) return;
  const keyStrings = parseStringPool(buf, pkgOff + keyStringsOff);

  // Walk the chunks inside the package, after its two string pools.
  let cursor = pkgOff + buf.readUInt16LE(pkgOff + 2);
  const end = pkgOff + pkgSize;
  while (cursor + 8 <= end) {
    const chunkType = buf.readUInt16LE(cursor);
    const chunkSize = buf.readUInt32LE(cursor + 4);
    if (chunkSize <= 0) break;
    if (chunkType === RES_TABLE_TYPE_TYPE) {
      parseTypeChunk(buf, cursor, keyStrings, globalStrings, result);
    }
    cursor += chunkSize;
  }
}

function parseTypeChunk(buf, off, keyStrings, globalStrings, result) {
  const headerSize = buf.readUInt16LE(off + 2);
  const flags = buf[off + 9];
  const entryCount = buf.readUInt32LE(off + 12);
  const entriesStart = buf.readUInt32LE(off + 16);
  const offsetsBase = off + headerSize;
  const entriesBase = off + entriesStart;

  if (flags & TYPE_FLAG_SPARSE) {
    for (let i = 0; i < entryCount; i++) {
      const idx = buf.readUInt16LE(offsetsBase + i * 4);
      const rel = buf.readUInt16LE(offsetsBase + i * 4 + 2) * 4;
      readEntry(buf, entriesBase + rel, keyStrings, globalStrings, result);
      void idx;
    }
    return;
  }

  const offset16 = (flags & TYPE_FLAG_OFFSET16) !== 0;
  for (let i = 0; i < entryCount; i++) {
    let rel;
    if (offset16) {
      rel = buf.readUInt16LE(offsetsBase + i * 2);
      if (rel === 0xffff) continue;
      rel *= 4;
    } else {
      rel = buf.readUInt32LE(offsetsBase + i * 4);
      if (rel === NO_ENTRY) continue;
    }
    readEntry(buf, entriesBase + rel, keyStrings, globalStrings, result);
  }
}

function readEntry(buf, entryOff, keyStrings, globalStrings, result) {
  const entrySize = buf.readUInt16LE(entryOff);
  const entryFlags = buf.readUInt16LE(entryOff + 2);
  const keyIdx = buf.readUInt32LE(entryOff + 4);
  if (entryFlags & ENTRY_FLAG_COMPLEX) return;

  const valueOff = entryOff + entrySize;
  const dataType = buf[valueOff + 3];
  if (dataType !== DATA_TYPE_STRING) return;
  const dataIdx = buf.readUInt32LE(valueOff + 4);
  const name = keyStrings[keyIdx];
  const value = globalStrings[dataIdx];
  if (name && value !== undefined && !result.has(name)) {
    result.set(name, value);
  }
}

module.exports = { readStringResources };
