// The source files of the app, for the tests that read the code itself instead of running it (the source guards of money-access.test.ts and ledger-access.test.ts). A guard that lists its
// files by hand misses the file added next week, so the guards ask for a directory and get every file under it.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The `src` directory of the app. */
export const SRC = path.resolve(__dirname, '../../../src');

/** Every `.ts` and `.tsx` file under a directory of `src` (the subdirectories too), as paths relative to `src` with forward slashes, in alphabetical order. */
export function sourcesUnder(directory: string): string[] {
  const found: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(path.join(SRC, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (/\.tsx?$/.test(entry.name)) found.push(child);
    }
  };
  walk(directory);
  return found.sort();
}

/** The text of a file of `src`, by its path relative to `src`. */
export function sourceText(file: string): string {
  return readFileSync(path.join(SRC, file), 'utf8');
}
