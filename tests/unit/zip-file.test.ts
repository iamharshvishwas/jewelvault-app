import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 as nodeCrc32 } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { crc32, createZip } from '@/lib/zipFile';
import { readZipEntries } from './support/zip';

// T-R05 (the zip of Download everything is a readable copy of the books, B3): the zip writer of the browser. There is no zip library in the application, so the writer is ours, and it is
// held to the format by three independent readers: the tests' own reader (tests/unit/support/zip.ts), the system's `unzip -t`, and (in tests/e2e/hidden-and-download.spec.ts) the Mac tool of
// the API, scripts/zip-balances.mjs. Files are stored, not compressed: a CSV copy of one shop's books is small, and a stored zip cannot fail to open for want of a codec.

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const bytes = (text: string) => new TextEncoder().encode(text);

describe('T-R05 the CRC-32 of a zip entry', () => {
  it('is the standard one: the check value of "123456789" is cbf43926, and the empty input is 0', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('agrees with the Node library on text, on bytes with the high bit set and on a long input', () => {
    const samples: Uint8Array[] = [
      bytes('customers.csv'),
      bytes('₹ 1,25,000.50 · नमस्ते · Meera'),
      Uint8Array.from({ length: 256 }, (_, i) => i),
      Uint8Array.from({ length: 300_000 }, (_, i) => (i * 31 + 7) & 0xff),
    ];
    for (const s of samples) expect(crc32(s)).toBe(nodeCrc32(s));
  });
});

describe('T-R05 createZip makes a zip that other readers open', () => {
  const files = [
    { name: 'customers.csv', data: bytes('﻿id,name\r\n1,Meera\r\n') },
    { name: 'empty.csv', data: new Uint8Array(0) },
    { name: 'नाम.csv', data: bytes('id\r\n') },
    { name: 'big.csv', data: Uint8Array.from({ length: 200_000 }, (_, i) => 65 + (i % 26)) },
  ];
  const when = new Date(2026, 9, 19, 12, 34, 56); // local time, as the browser's clock gives it
  const zip = createZip(files, when);

  it('holds every file under its name with its bytes, each checked against its own checksum', () => {
    const entries = readZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
    entries.forEach((entry, i) => {
      expect(Buffer.compare(entry.data, Buffer.from(files[i].data))).toBe(0);
      expect(entry.method).toBe(0); // stored
      expect(entry.flags & 0x0800).toBe(0x0800); // the names are UTF-8
    });
  });

  it('writes the date of the file as a DOS date and time (2s resolution, local time)', () => {
    // local header of the first file: time at offset 10, date at offset 12
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const time = view.getUint16(10, true);
    const date = view.getUint16(12, true);
    expect({ h: time >> 11, m: (time >> 5) & 63, s: (time & 31) * 2 }).toEqual({
      h: 12,
      m: 34,
      s: 56,
    });
    expect({ y: 1980 + (date >> 9), mo: (date >> 5) & 15, d: date & 31 }).toEqual({
      y: 2026,
      mo: 10,
      d: 19,
    });
  });

  const unzip = spawnSync('unzip', ['-v'], { encoding: 'utf8' });
  it.skipIf(unzip.error !== undefined)(
    'is accepted by the system unzip (unzip -t) and lists the same files',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'jv-zip-'));
      dirs.push(dir);
      const file = path.join(dir, 'x.zip');
      writeFileSync(file, zip);
      const test = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
      expect(test.stdout + test.stderr).toContain('No errors detected');
      expect(test.status).toBe(0);
      for (const f of ['customers.csv', 'empty.csv', 'big.csv']) expect(test.stdout).toContain(f);
    }
  );

  it('an empty list of files is a valid empty zip, not a broken one', () => {
    const empty = createZip([], when);
    expect(readZipEntries(empty)).toEqual([]);
  });

  it('refuses two files of one name (a reader would keep one of them and nobody would know which)', () => {
    expect(() => createZip([files[0], files[0]], when)).toThrow(/twice|same name|duplicate/i);
  });

  it('refuses a name with a path in it and an empty name (the files are flat)', () => {
    expect(() => createZip([{ name: '../x.csv', data: bytes('a') }], when)).toThrow(/name/i);
    expect(() => createZip([{ name: 'a/b.csv', data: bytes('a') }], when)).toThrow(/name/i);
    expect(() => createZip([{ name: '', data: bytes('a') }], when)).toThrow(/name/i);
  });
});
