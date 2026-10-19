// A zip writer for Download everything (spec B3; task WEB12b). Pure: bytes in, bytes out, no browser API.
//
// The application has no zip library and gets none for one monthly button: the format is a few fixed headers. The files are STORED, not compressed (method 0): the CSV copy of one shop's
// books is a few megabytes, every unzip program opens a stored file, and there is no codec to be missing. The names are marked UTF-8 (bit 11), so a Hindi or Gujarati file name survives.
// Zip64 is not written: a zip of 65,535 files or 4 GiB is refused, which no copy of this shop's books comes near.
//
// What reads it: the system `unzip`, a spreadsheet's import, and the Mac tool of the API (`scripts/zip-balances.mjs`, T-R05), which finds the files through the central directory.

export interface ZipFileInput {
  /** A flat file name: no folder, no `..`. */
  name: string;
  data: Uint8Array;
}

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 (IEEE 802.3, the one a zip entry carries) of the bytes, as an unsigned number. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const UTF8_NAMES = 0x0800;
const VERSION = 20;
const MAX_ENTRIES = 0xfffe;
const MAX_BYTES = 0xfffffffe;

/** The DOS time and date of a moment in the computer's own time zone (a zip carries no zone; two seconds is its resolution). */
function dosStamp(moment: Date): { time: number; date: number } {
  const year = Math.min(Math.max(moment.getFullYear(), 1980), 2107);
  return {
    time: (moment.getHours() << 11) | (moment.getMinutes() << 5) | (moment.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((moment.getMonth() + 1) << 5) | moment.getDate(),
  };
}

/** A zip of the files, stored, in the order given. Throws on a name that is empty, has a folder in it or repeats, and on a zip too big for the plain format. */
export function createZip(files: readonly ZipFileInput[], modified: Date): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const entries = files.map((file) => {
    if (file.name === '' || /[\\/]/.test(file.name) || file.name === '.' || file.name === '..')
      throw new Error(`The name "${file.name}" cannot be a file name in the zip.`);
    if (seen.has(file.name)) throw new Error(`The file name "${file.name}" is in the zip twice.`);
    seen.add(file.name);
    return { name: encoder.encode(file.name), data: file.data, crc: crc32(file.data) };
  });
  if (entries.length > MAX_ENTRIES) throw new Error('A zip made here holds at most 65,534 files.');

  let size = 22;
  for (const e of entries) {
    size += 30 + e.name.length + e.data.length + 46 + e.name.length;
    if (e.data.length > MAX_BYTES)
      throw new Error(
        `The file ${new TextDecoder().decode(e.name)} is too big for a zip made here.`
      );
  }
  if (size > MAX_BYTES) throw new Error('The zip is too big for a zip made here (4 GiB).');

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  const { time, date } = dosStamp(modified);
  let pos = 0;
  const offsets: number[] = [];

  for (const e of entries) {
    offsets.push(pos);
    view.setUint32(pos, 0x04034b50, true);
    view.setUint16(pos + 4, VERSION, true);
    view.setUint16(pos + 6, UTF8_NAMES, true);
    view.setUint16(pos + 8, 0, true); // stored
    view.setUint16(pos + 10, time, true);
    view.setUint16(pos + 12, date, true);
    view.setUint32(pos + 14, e.crc, true);
    view.setUint32(pos + 18, e.data.length, true);
    view.setUint32(pos + 22, e.data.length, true);
    view.setUint16(pos + 26, e.name.length, true);
    view.setUint16(pos + 28, 0, true);
    out.set(e.name, pos + 30);
    out.set(e.data, pos + 30 + e.name.length);
    pos += 30 + e.name.length + e.data.length;
  }

  const directoryStart = pos;
  entries.forEach((e, i) => {
    view.setUint32(pos, 0x02014b50, true);
    view.setUint16(pos + 4, VERSION, true); // made by
    view.setUint16(pos + 6, VERSION, true); // needed to extract
    view.setUint16(pos + 8, UTF8_NAMES, true);
    view.setUint16(pos + 10, 0, true);
    view.setUint16(pos + 12, time, true);
    view.setUint16(pos + 14, date, true);
    view.setUint32(pos + 16, e.crc, true);
    view.setUint32(pos + 20, e.data.length, true);
    view.setUint32(pos + 24, e.data.length, true);
    view.setUint16(pos + 28, e.name.length, true);
    view.setUint16(pos + 30, 0, true); // extra
    view.setUint16(pos + 32, 0, true); // comment
    view.setUint16(pos + 34, 0, true); // disk
    view.setUint16(pos + 36, 0, true); // internal attributes
    view.setUint32(pos + 38, 0, true); // external attributes
    view.setUint32(pos + 42, offsets[i], true);
    out.set(e.name, pos + 46);
    pos += 46 + e.name.length;
  });

  view.setUint32(pos, 0x06054b50, true);
  view.setUint16(pos + 4, 0, true);
  view.setUint16(pos + 6, 0, true);
  view.setUint16(pos + 8, entries.length, true);
  view.setUint16(pos + 10, entries.length, true);
  view.setUint32(pos + 12, pos - directoryStart, true);
  view.setUint32(pos + 16, directoryStart, true);
  view.setUint16(pos + 20, 0, true);
  return out;
}
