import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// PT-W15 (task WEB15): one clean app. The old database pieces and the preview switch are gone from the repository, and nothing that is left can bring them back: no file
// names the old back end, no source file reads the preview variable, the build check lets exactly one build-time variable through, and the sample data of the prototype
// is not in the bundle. The browser half (a build made with NEXT_PUBLIC_PREVIEW_MODE=1 opens the login screen) is tests/e2e/no-preview.spec.ts.

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const exists = (file: string) => existsSync(path.join(root, file));

// The word is written in two halves on purpose: this file is one of the files the search below reads, and it must not be a hit of its own search.
const OLD_BACKEND = ['supa', 'base'].join('');

/** Every file of the repository that is not ignored: tracked, or new and not in .gitignore. */
function repositoryFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  return out
    .split('\0')
    .filter(Boolean)
    .filter((file) => {
      try {
        return statSync(path.join(root, file)).isFile();
      } catch {
        return false; // listed but deleted from the working tree
      }
    });
}

describe('PT-W15 no file of the repository names the old back end', () => {
  const files = repositoryFiles();

  it('looks at the whole repository (so that an empty list cannot pass this test)', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('package.json');
    expect(files).toContain('package-lock.json');
    expect(files).toContain('src/app/page.tsx');
  });

  it('finds the word in none of them, in any case: the same search as `grep -rIil` for it from the project root', () => {
    const hits = files.filter((file) => {
      const data = readFileSync(path.join(root, file));
      if (data.includes(0)) return false; // a binary file (grep -I skips them)
      return data.toString('utf8').toLowerCase().includes(OLD_BACKEND);
    });
    expect(hits).toEqual([]);
  });
});

describe('PT-W15 the old pieces are deleted', () => {
  it.each([
    `src/lib/${OLD_BACKEND}`,
    'src/lib/previewMode.ts',
    OLD_BACKEND,
    'scripts/lane.mjs',
    'scripts/check-migrations.sh',
    'tests/db',
    'tests/unit/lane.test.ts',
    'tests/unit/migrations-check.test.ts',
    'tests/unit/preview-mode.test.ts',
  ])('%s is gone', (file) => {
    expect(exists(file), file).toBe(false);
  });

  it('package.json has no database client or command-line tool, and no script of the old lanes', () => {
    const pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const installed = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of [`@${OLD_BACKEND}/${OLD_BACKEND}-js`, OLD_BACKEND, 'pg', '@types/pg']) {
      expect(installed[name], name).toBeUndefined();
    }
    for (const [name, command] of Object.entries(pkg.scripts)) {
      expect(name, name).not.toMatch(/^db:|^lane$/);
      expect(command, name).not.toMatch(/scripts\/lane\.mjs|check-migrations/);
    }
  });

  it('keeps the gates `verify` and `lint:changed` that lived in the deleted lane tool, now in scripts/verify.mjs', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> })
      .scripts;
    expect(scripts.verify).toBe('node scripts/verify.mjs verify');
    expect(scripts['lint:changed']).toBe('node scripts/verify.mjs lint-changed');
    expect(exists('scripts/verify.mjs')).toBe(true);
  });

  it('the lock file lists none of the removed packages', () => {
    const lock = JSON.parse(read('package-lock.json')) as {
      packages: Record<string, unknown>;
    };
    const names = Object.keys(lock.packages);
    expect(names.filter((name) => name.includes(OLD_BACKEND))).toEqual([]);
    expect(names).not.toContain('node_modules/pg');
    expect(names).not.toContain('node_modules/@types/pg');
  });
});

describe('PT-W15 the preview switch is gone from the code', () => {
  it('no file of src/ reads or names it', () => {
    const files = repositoryFiles().filter((file) => file.startsWith('src/'));
    expect(files.length).toBeGreaterThan(100);
    const hits = files.filter((file) =>
      /PREVIEW_MODE|previewMode|NEXT_PUBLIC_PREVIEW/.test(read(file))
    );
    expect(hits).toEqual([]);
  });

  it('the session store has no preview state and takes no preview option', () => {
    const text = read('src/lib/authStore.ts');
    expect(text).not.toMatch(/preview/i);
  });

  it('the layout draws no preview note', () => {
    expect(read('src/components/AppLayout.tsx')).not.toMatch(/preview/i);
  });

  it('src/lib/mockData.ts holds the shapes of the screens and no sample data: it has nothing at run time', async () => {
    const shapes = (await import('@/lib/mockData')) as Record<string, unknown>;
    expect(Object.keys(shapes)).toEqual([]);
  });

  it('no unit test stubs the preview variable any more (there is no second kind of build to test)', () => {
    const offenders = repositoryFiles()
      .filter((file) => file.startsWith('tests/unit/') && file.endsWith('.ts'))
      .filter((file) => /stubEnv\(\s*['"]NEXT_PUBLIC_PREVIEW_MODE/.test(read(file)));
    expect(offenders).toEqual([]);
  });
});
