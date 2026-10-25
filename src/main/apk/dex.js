'use strict';

// Minimal reader for Android DEX files: just enough to read the constant
// values of a class's static fields (e.g. BuildConfig.OAUTH_CLIENT_ID).
// Format reference: https://source.android.com/docs/core/runtime/dex-format

const VALUE_BYTE = 0x00;
const VALUE_SHORT = 0x02;
const VALUE_CHAR = 0x03;
const VALUE_INT = 0x04;
const VALUE_LONG = 0x06;
const VALUE_FLOAT = 0x10;
const VALUE_DOUBLE = 0x11;
const VALUE_STRING = 0x17;
const VALUE_ARRAY = 0x1c;
const VALUE_ANNOTATION = 0x1d;
const VALUE_NULL = 0x1e;
const VALUE_BOOLEAN = 0x1f;

class Cursor {
  constructor(buf, pos) {
    this.buf = buf;
    this.pos = pos;
  }

  u8() {
    return this.buf[this.pos++];
  }

  uleb128() {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.buf[this.pos++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
    throw new Error('DEX: uleb128 demasiado largo');
  }

  // Reads `size` little-endian bytes as an unsigned BigInt.
  bytes(size) {
    let v = 0n;
    for (let i = 0; i < size; i++) v |= BigInt(this.buf[this.pos++]) << BigInt(8 * i);
    return v;
  }
}

// DEX strings are MUTF-8 (CESU-8 surrogates, 0xC0 0x80 for NUL).
function decodeMutf8(buf, pos) {
  const units = [];
  for (;;) {
    const a = buf[pos++];
    if (a === 0) break;
    if (a < 0x80) {
      units.push(a);
    } else if ((a & 0xe0) === 0xc0) {
      const b = buf[pos++];
      units.push(((a & 0x1f) << 6) | (b & 0x3f));
    } else {
      const b = buf[pos++];
      const c = buf[pos++];
      units.push(((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f));
    }
  }
  let out = '';
  for (let i = 0; i < units.length; i += 4096) {
    out += String.fromCharCode.apply(null, units.slice(i, i + 4096));
  }
  return out;
}

class DexFile {
  constructor(buf) {
    if (buf.length < 0x70 || buf.toString('latin1', 0, 4) !== 'dex\n') {
      throw new Error('No es un archivo DEX');
    }
    this.buf = buf;
    this.stringIdsSize = buf.readUInt32LE(56);
    this.stringIdsOff = buf.readUInt32LE(60);
    this.typeIdsSize = buf.readUInt32LE(64);
    this.typeIdsOff = buf.readUInt32LE(68);
    this.fieldIdsSize = buf.readUInt32LE(80);
    this.fieldIdsOff = buf.readUInt32LE(84);
    this.classDefsSize = buf.readUInt32LE(96);
    this.classDefsOff = buf.readUInt32LE(100);
  }

  string(idx) {
    const dataOff = this.buf.readUInt32LE(this.stringIdsOff + idx * 4);
    const c = new Cursor(this.buf, dataOff);
    c.uleb128(); // utf16 length
    return decodeMutf8(this.buf, c.pos);
  }

  // string_ids are sorted by content, so we can binary search them.
  findString(value) {
    let lo = 0;
    let hi = this.stringIdsSize - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const s = this.string(mid);
      if (s === value) return mid;
      if (compareDexStrings(s, value) < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  // type_ids are sorted by descriptor string index.
  findType(stringIdx) {
    let lo = 0;
    let hi = this.typeIdsSize - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const s = this.buf.readUInt32LE(this.typeIdsOff + mid * 4);
      if (s === stringIdx) return mid;
      if (s < stringIdx) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  fieldName(fieldIdx) {
    const nameIdx = this.buf.readUInt32LE(this.fieldIdsOff + fieldIdx * 8 + 4);
    return this.string(nameIdx);
  }

  findClassDef(typeIdx) {
    for (let i = 0; i < this.classDefsSize; i++) {
      const off = this.classDefsOff + i * 32;
      if (this.buf.readUInt32LE(off) === typeIdx) {
        return {
          classDataOff: this.buf.readUInt32LE(off + 24),
          staticValuesOff: this.buf.readUInt32LE(off + 28),
        };
      }
    }
    return null;
  }

  readEncodedValue(c) {
    const header = c.u8();
    const type = header & 0x1f;
    const arg = header >> 5;
    switch (type) {
      case VALUE_BYTE:
      case VALUE_SHORT:
      case VALUE_INT:
      case VALUE_LONG: {
        const size = arg + 1;
        let v = c.bytes(size);
        const signBit = 1n << BigInt(size * 8 - 1);
        if (v & signBit) v -= 1n << BigInt(size * 8);
        return type === VALUE_LONG ? v : Number(v);
      }
      case VALUE_CHAR:
        return String.fromCharCode(Number(c.bytes(arg + 1)));
      case VALUE_FLOAT:
      case VALUE_DOUBLE: {
        // Zero-extended to the right.
        const width = type === VALUE_FLOAT ? 4 : 8;
        const raw = c.bytes(arg + 1) << BigInt(8 * (width - (arg + 1)));
        const b = Buffer.alloc(8);
        if (width === 4) {
          b.writeUInt32LE(Number(raw));
          return b.readFloatLE(0);
        }
        b.writeBigUInt64LE(raw);
        return b.readDoubleLE(0);
      }
      case VALUE_STRING:
        return this.string(Number(c.bytes(arg + 1)));
      case VALUE_ARRAY: {
        const size = c.uleb128();
        const items = [];
        for (let i = 0; i < size; i++) items.push(this.readEncodedValue(c));
        return items;
      }
      case VALUE_ANNOTATION: {
        c.uleb128(); // type_idx
        const size = c.uleb128();
        for (let i = 0; i < size; i++) {
          c.uleb128();
          this.readEncodedValue(c);
        }
        return null;
      }
      case VALUE_NULL:
        return null;
      case VALUE_BOOLEAN:
        return arg !== 0;
      default:
        // TYPE, FIELD, METHOD, ENUM, METHOD_TYPE, METHOD_HANDLE: an index.
        c.bytes(arg + 1);
        return undefined;
    }
  }

  // Returns { fieldName: value } for the static fields of `descriptor`
  // (e.g. "Lcom/example/BuildConfig;"), or null if the class is not here.
  staticValues(descriptor) {
    const sIdx = this.findString(descriptor);
    if (sIdx < 0) return null;
    const tIdx = this.findType(sIdx);
    if (tIdx < 0) return null;
    const def = this.findClassDef(tIdx);
    if (!def || !def.classDataOff) return null;

    const c = new Cursor(this.buf, def.classDataOff);
    const staticFieldsSize = c.uleb128();
    c.uleb128(); // instance fields
    c.uleb128(); // direct methods
    c.uleb128(); // virtual methods
    const names = [];
    let fieldIdx = 0;
    for (let i = 0; i < staticFieldsSize; i++) {
      fieldIdx += c.uleb128();
      c.uleb128(); // access flags
      names.push(this.fieldName(fieldIdx));
    }

    const result = {};
    if (def.staticValuesOff) {
      const v = new Cursor(this.buf, def.staticValuesOff);
      const size = v.uleb128();
      for (let i = 0; i < size && i < names.length; i++) {
        result[names[i]] = this.readEncodedValue(v);
      }
    }
    return result;
  }
}

// DEX sorts strings by UTF-16 code unit values, which matches JS comparison.
function compareDexStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

module.exports = { DexFile, decodeMutf8 };
