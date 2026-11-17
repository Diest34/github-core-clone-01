// git.ts — the git object model, packfiles and pkt-line framing, implemented from the kit's
// program/env/src/git-client.ts contract (the suite's client) and the git wire format. No git
// binary, no dependencies: node:crypto for SHA-1, node:zlib for deflate/inflate.
//
// Object ids are SHA-1 over "<type> <size>\0" + bytes, exactly as git computes them.

import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && OID_RE.test(value);
}

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function makeObject(type: ObjectType, data: Buffer): { oid: string; object: GitObject } {
  return { oid: hashObject(type, data), object: { type, data } };
}

// --------------------------------------------------------------------------- pkt-line

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface GitPacket {
  kind: PktKind;
  payload: Buffer;
  raw: Buffer;
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');
const RESPONSE_END = Buffer.from('0002', 'ascii');

/** Encode one pkt-line (4 hex length digits + payload; payload includes its trailing \n). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return FLUSH;
}
export function pktDelim(): Buffer {
  return DELIM;
}

/** Encode a list of lines / flush / delim markers into pkt-lines. */
export function encodePktLines(lines: readonly (string | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(FLUSH);
    else if (line === 'delim') parts.push(DELIM);
    else if (line === 'response-end') parts.push(RESPONSE_END);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines. Throws on a malformed frame. */
export function decodePktLines(buffer: Buffer): GitPacket[] {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const lenText = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(lenText)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0), raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0), raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0), raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buffer.length) throw new Error('bad pkt-line length');
    packets.push({
      kind: 'data',
      payload: buffer.subarray(offset + 4, offset + len),
      raw: buffer.subarray(offset, offset + len),
    });
    offset += len;
  }
  return packets;
}

/** The text of the data packets, in order. */
export function pktTexts(packets: readonly GitPacket[]): string[] {
  return packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
}

// --------------------------------------------------------------------------- objects

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('bad tree entry');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('bad tree entry');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object from entries, sorted git's way (directories compare as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object. */
export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// --------------------------------------------------------------------------- packs

const TYPE_NUM: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Write a packfile (version 2, plain objects, no deltas) from a list of objects. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  // Deterministic order: by oid.
  const sorted = [...objects].sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  for (const object of sorted) {
    const typeNum = TYPE_NUM[object.type];
    const size = object.data.length;
    // varint: low 4 bits of size in the first byte, then 7 bits per byte.
    const head: number[] = [];
    let remaining = size;
    let first = (typeNum << 4) | (remaining & 0x0f);
    remaining >>>= 4;
    if (remaining > 0) first |= 0x80;
    head.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>>= 7;
      if (remaining > 0) byte |= 0x80;
      head.push(byte);
    }
    parts.push(Buffer.from(head));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Read a packfile: returns the objects by oid, with deltas resolved. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (trailer.toString('hex') !== actual) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { oid: string; object: GitObject }>();
  let offset = 12;
  interface Pending {
    oid: string;
    type: 'ofs' | 'ref';
    baseOid?: string;
    baseOffset?: number;
    entryOffset: number;
    delta: Buffer;
  }
  const pending: Pending[] = [];
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    offset += 1;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeNum === 6) {
      byte = pack[offset];
      offset += 1;
      let off = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        off = ((off + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - off;
    } else if (typeNum === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data, consumed } = inflateRaw(pack.subarray(offset));
    offset += consumed;
    if (typeNum === 6 || typeNum === 7) {
      // The delta's own oid is unknown until resolved; store under a synthetic key.
      pending.push({ oid: `pending:${entryOffset}`, type: typeNum === 6 ? 'ofs' : 'ref', baseOid, baseOffset, entryOffset, delta: data });
      // Keep a placeholder so later OFS deltas can chain off this entry's offset.
      byOffset.set(entryOffset, { oid: `pending:${entryOffset}`, object: { type: 'blob', data } });
      continue;
    }
    const type = NUM_TYPE[typeNum];
    if (type === undefined) throw new Error(`unknown pack object type ${typeNum}`);
    if (data.length !== size) throw new Error('pack object size mismatch');
    const oid = hashObject(type, data);
    const object: GitObject = { type, data };
    objects.set(oid, object);
    byOffset.set(entryOffset, { oid, object });
  }
  // Resolve deltas (possibly chained): repeat until none remain or no progress.
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const item = pending[i] as Pending;
      let base: GitObject | undefined;
      if (item.type === 'ref') base = item.baseOid === undefined ? undefined : objects.get(item.baseOid);
      else {
        const entry = item.baseOffset === undefined ? undefined : byOffset.get(item.baseOffset);
        base = entry?.object;
        if (entry !== undefined && entry.oid.startsWith('pending:')) base = undefined;
      }
      if (base === undefined) continue;
      const data = applyDelta(base.data, item.delta);
      const oid = hashObject(base.type, data);
      const object: GitObject = { type: base.type, data };
      objects.set(oid, object);
      // A later delta may chain off this entry's offset: point it at the resolved object.
      byOffset.set(item.entryOffset, { oid, object });
      pending.splice(i, 1);
      progress = true;
    }
  }
  if (pending.length > 0) throw new Error('pack has an unresolvable delta base');
  return objects;
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  let total = 0;
  while (offset < delta.length) {
    const opcode = delta[offset] as number;
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (opcode & (1 << bit)) {
          copyOffset |= (delta[offset] as number) << (bit * 8);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (opcode & (0x10 << bit)) {
          copySize |= (delta[offset] as number) << (bit * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      total += copySize;
    } else if (opcode > 0) {
      parts.push(delta.subarray(offset, offset + opcode));
      total += opcode;
      offset += opcode;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== resultSize || total !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

// --------------------------------------------------------------------------- raw inflate
//
// Node's zlib.inflateSync does not report how many input bytes the stream consumed, and a
// packfile needs that to find the next entry. This is a small DEFLATE decoder (RFC 1951) over
// the zlib wrapper (RFC 1950): it handles stored, fixed-Huffman and dynamic-Huffman blocks,
// which is everything deflateSync emits.

function inflateRaw(input: Buffer): { data: Buffer; consumed: number } {
  if (input.length < 2) throw new Error('short zlib stream');
  const cmf = input[0] as number;
  const flg = input[1] as number;
  if ((cmf & 0x0f) !== 8) throw new Error('not a deflate stream');
  if (((cmf << 8) | flg) % 31 !== 0) throw new Error('bad zlib header');
  if (flg & 0x20) throw new Error('preset dictionary not supported');
  let bitPos = 16; // bit offset into input
  const out: number[] = [];
  const readBits = (count: number): number => {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = input[bitPos >> 3] as number;
      value |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos += 1;
    }
    return value;
  };
  const readHuffman = (table: HuffmanTable): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len += 1) {
      code |= readBits(1);
      const count = table.count[len] ?? 0;
      if (code - first < count) return table.symbols[index + (code - first)] as number;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('bad huffman code');
  };
  for (;;) {
    const finalBlock = readBits(1);
    const blockType = readBits(2);
    if (blockType === 0) {
      // Stored: align to a byte boundary, then LEN/NLEN + raw bytes.
      bitPos = (bitPos + 7) & ~7;
      const bytePos = bitPos >> 3;
      const len = input[bytePos] | ((input[bytePos + 1] as number) << 8);
      const nlen = input[bytePos + 2] | ((input[bytePos + 3] as number) << 8);
      if ((len ^ 0xffff) !== nlen) throw new Error('bad stored block lengths');
      for (let i = 0; i < len; i += 1) out.push(input[bytePos + 4 + i] as number);
      bitPos = (bytePos + 4 + len) * 8;
    } else {
      let litTable: HuffmanTable;
      let distTable: HuffmanTable;
      if (blockType === 1) {
        litTable = fixedLiteralTable();
        distTable = fixedDistanceTable();
      } else if (blockType === 2) {
        const hlit = readBits(5) + 257;
        const hdist = readBits(5) + 1;
        const hclen = readBits(4) + 4;
        const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        const codeLengths = new Array<number>(19).fill(0);
        for (let i = 0; i < hclen; i += 1) codeLengths[order[i] as number] = readBits(3);
        const codeTable = buildHuffman(codeLengths);
        const lengths = new Array<number>(hlit + hdist).fill(0);
        let i = 0;
        while (i < hlit + hdist) {
          const symbol = readHuffman(codeTable);
          if (symbol < 16) {
            lengths[i] = symbol;
            i += 1;
          } else if (symbol === 16) {
            const repeat = 3 + readBits(2);
            const prev = lengths[i - 1] as number;
            for (let j = 0; j < repeat; j += 1) {
              lengths[i] = prev;
              i += 1;
            }
          } else if (symbol === 17) {
            const repeat = 3 + readBits(3);
            i += repeat;
          } else {
            const repeat = 11 + readBits(7);
            i += repeat;
          }
        }
        litTable = buildHuffman(lengths.slice(0, hlit));
        distTable = buildHuffman(lengths.slice(hlit));
      } else {
        throw new Error('bad deflate block type');
      }
      const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
      const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
      const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
      const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
      for (;;) {
        const symbol = readHuffman(litTable);
        if (symbol < 256) {
          out.push(symbol);
        } else if (symbol === 256) {
          break;
        } else {
          const li = symbol - 257;
          const length = (LENGTH_BASE[li] as number) + readBits(LENGTH_EXTRA[li] as number);
          const dsym = readHuffman(distTable);
          const dist = (DIST_BASE[dsym] as number) + readBits(DIST_EXTRA[dsym] as number);
          for (let j = 0; j < length; j += 1) out.push(out[out.length - dist] as number);
        }
      }
    }
    if (finalBlock === 1) break;
  }
  const consumed = Math.ceil(bitPos / 8) + 4; // +4: adler32 trailer
  return { data: Buffer.from(out), consumed };
}

interface HuffmanTable {
  count: number[];
  symbols: number[];
}

function buildHuffman(lengths: readonly number[]): HuffmanTable {
  const count = new Array<number>(16).fill(0);
  for (const len of lengths) if (len > 0) count[len] = (count[len] as number) + 1;
  const offsets = new Array<number>(16).fill(0);
  for (let len = 1; len < 15; len += 1) offsets[len + 1] = (offsets[len] as number) + (count[len] as number);
  const symbols = new Array<number>(lengths.filter((len) => len > 0).length);
  for (let i = 0; i < lengths.length; i += 1) {
    const len = lengths[i] as number;
    if (len > 0) {
      symbols[offsets[len] as number] = i;
      offsets[len] = (offsets[len] as number) + 1;
    }
  }
  return { count, symbols };
}

let fixedLit: HuffmanTable | null = null;
let fixedDist: HuffmanTable | null = null;

function fixedLiteralTable(): HuffmanTable {
  if (fixedLit === null) {
    const lengths = new Array<number>(288).fill(0);
    for (let i = 0; i < 144; i += 1) lengths[i] = 8;
    for (let i = 144; i < 256; i += 1) lengths[i] = 9;
    for (let i = 256; i < 280; i += 1) lengths[i] = 7;
    for (let i = 280; i < 288; i += 1) lengths[i] = 8;
    fixedLit = buildHuffman(lengths);
  }
  return fixedLit;
}

function fixedDistanceTable(): HuffmanTable {
  if (fixedDist === null) fixedDist = buildHuffman(new Array<number>(32).fill(5));
  return fixedDist;
}

// A random token for request ids when determinism is not required (never used in bodies).
export function randomToken(bytes = 8): string {
  return randomBytes(bytes).toString('hex');
}
