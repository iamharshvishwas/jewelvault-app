// A reader of zip files for the tests of Download everything (WEB12b): the files of a zip by name, through the central directory, stored or deflated, each checked against its CRC-32.
// It is the tests' own reader, written apart from the writer under test (src/lib/zipFile.ts); the real check that other tools can open the file is `unzip -t` in download-everything.test.ts
// and the pulled-forward tool `scripts/zip-balances.mjs` of the API in tests/e2e/hidden-and-download.spec.ts.
import { crc32, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
  /** The general-purpose flags and the method as written, so a test can check that the names are marked UTF-8. */
  flags: number;
  method: number;
}

export function readZipEntries(zip: Uint8Array | Buffer): ZipEntry[] {
  const buf = Buffer.isBuffer(zip) ? zip : Buffer.from(zip);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  const total = buf.readUInt16LE(eocd + 8);
  if (count !== total)
    throw new Error('a zip in one piece has the same number of entries on this disk and in all');
  let pos = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('the zip directory is damaged');
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compressed = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    pos += 46 + nameLength + extraLength + commentLength;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`the zip is damaged at ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + compressed);
    const data = method === 0 ? body : method === 8 ? inflateRawSync(body) : null;
    if (data === null) throw new Error(`${name}: compression method ${method}`);
    if (data.length !== size)
      throw new Error(`${name}: the size in the directory is ${size}, the file has ${data.length}`);
    if (crc32(data) !== crc) throw new Error(`${name}: the checksum does not match`);
    entries.push({ name, data: Buffer.from(data), flags, method });
  }
  return entries;
}

/** The text of every file of the zip, by name. */
export function readZipText(zip: Uint8Array | Buffer): Map<string, string> {
  return new Map(readZipEntries(zip).map((e) => [e.name, e.data.toString('utf8')]));
}
