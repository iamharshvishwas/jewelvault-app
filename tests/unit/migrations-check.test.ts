import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as lane from '../../scripts/lane.mjs';

// T-F04 (BUILD), the file half: the rules of S9 that can be checked without a database.
// The database half (two fresh applications give the same schema, the advisor is clean)
// runs inside `npm run db:check`, and the fingerprint it compares is proved in tests/db.

const root = path.resolve(__dirname, '../..');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'jv-migrations-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, sql: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), sql);
}
const problems = (): Array<{ file: string; message: string }> => lane.lintMigrationFiles(dir);
const GOOD = '20261015090000_0001_example.sql';

describe('migration file rules (S9)', () => {
  it('accepts an empty folder: there is nothing to check yet', () => {
    expect(problems()).toEqual([]);
  });

  it('accepts a table that enables row-level security in the same file', () => {
    write(
      GOOD,
      'create table public.things (id uuid primary key);\nalter table public.things enable row level security;\n'
    );
    expect(problems()).toEqual([]);
  });

  it('refuses a table that does not enable row-level security in its file', () => {
    write(GOOD, 'create table public.things (id uuid primary key);\n');
    const found = problems();
    expect(found).toHaveLength(1);
    expect(found[0].file).toBe(GOOD);
    expect(found[0].message).toMatch(/public\.things/);
    expect(found[0].message).toMatch(/row level security/i);
  });

  it('refuses row-level security enabled in a later file: the same file is the rule', () => {
    write(GOOD, 'create table public.things (id uuid primary key);\n');
    write(
      '20261015100000_0002_later.sql',
      'alter table public.things enable row level security;\n'
    );
    expect(problems().map((p) => p.file)).toEqual([GOOD]);
  });

  it('refuses row-level security enabled for another table', () => {
    write(
      GOOD,
      'create table public.a (id int);\ncreate table public.b (id int);\nalter table public.a enable row level security;\n'
    );
    const found = problems();
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/public\.b/);
  });

  it('does not count a table that is only mentioned in a comment', () => {
    write(
      GOOD,
      '-- create table public.ghost (id int);\n/* create table public.ghost2 (id int); */\nselect 1;\n'
    );
    expect(problems()).toEqual([]);
  });

  it('does not count a row-level security line that is only a comment', () => {
    write(
      GOOD,
      'create table public.a (id int);\n-- alter table public.a enable row level security;\n'
    );
    expect(problems()).toHaveLength(1);
  });

  it('understands quoted names, if not exists, only, and an unqualified name meaning public', () => {
    write(
      GOOD,
      [
        'create table if not exists "public"."q" (id int);',
        'alter table only "public"."q" enable row level security;',
        'create table plain (id int);',
        'alter table public.plain enable row level security;',
        'CREATE TABLE private.p (id int);',
        'ALTER TABLE IF EXISTS private.p ENABLE ROW LEVEL SECURITY;',
      ].join('\n')
    );
    expect(problems()).toEqual([]);
  });

  it('ignores temporary tables', () => {
    write(GOOD, 'create temp table scratch (id int);\ncreate temporary table scratch2 (id int);\n');
    expect(problems()).toEqual([]);
  });

  it('refuses a file name that is not <14 digit version>_<name>.sql', () => {
    write('0001_privileges.sql', 'select 1;\n');
    write('20261015090000-privileges.sql', 'select 1;\n');
    write('20261015090000_Privileges.sql', 'select 1;\n');
    const files = problems().map((p) => p.file);
    expect(files).toEqual(
      expect.arrayContaining([
        '0001_privileges.sql',
        '20261015090000-privileges.sql',
        '20261015090000_Privileges.sql',
      ])
    );
  });

  it('refuses two files with the same version', () => {
    write('20261015090000_a.sql', 'select 1;\n');
    write('20261015090000_b.sql', 'select 2;\n');
    expect(problems().some((p) => /same version/i.test(p.message))).toBe(true);
  });

  it('refuses an empty migration', () => {
    write(GOOD, '-- nothing here\n\n');
    expect(problems().some((p) => /empty/i.test(p.message))).toBe(true);
  });

  it('lets .gitkeep be', () => {
    write('.gitkeep', '');
    expect(problems()).toEqual([]);
  });
});

describe('forward-only (a merged migration is never edited)', () => {
  const lines = (...l: string[]) => l.join('\n');

  it('accepts files that were only added', () => {
    expect(
      lane.forwardOnlyProblems(
        lines(
          'A\tsupabase/migrations/20261015090000_a.sql',
          'A\tsupabase/migrations/20261015100000_b.sql'
        )
      )
    ).toEqual([]);
  });

  it('refuses a modified, deleted or renamed migration', () => {
    const found = lane.forwardOnlyProblems(
      lines(
        'M\tsupabase/migrations/20261015090000_a.sql',
        'D\tsupabase/migrations/20261015100000_b.sql',
        'R100\tsupabase/migrations/20261015110000_c.sql\tsupabase/migrations/20261015110001_c.sql'
      )
    ) as Array<{ file: string; message: string }>;
    expect(found).toHaveLength(3);
    expect(found[0].message).toMatch(/already merged/i);
  });

  it('ignores everything outside supabase/migrations and the .gitkeep', () => {
    expect(
      lane.forwardOnlyProblems(
        lines('M\tsupabase/config.toml', 'M\tREADME.md', 'D\tsupabase/migrations/.gitkeep')
      )
    ).toEqual([]);
  });
});

describe('comparing two schema fingerprints', () => {
  it('says same for equal text', () => {
    expect(lane.compareFingerprints('a\nb\n', 'a\nb\n')).toEqual({ same: true, diff: '' });
  });

  it('shows the differing lines when the schemas differ', () => {
    const result = lane.compareFingerprints('a\nb\nc\n', 'a\nX\nc\n') as {
      same: boolean;
      diff: string;
    };
    expect(result.same).toBe(false);
    expect(result.diff).toMatch(/-b/);
    expect(result.diff).toMatch(/\+X/);
  });
});

describe('scripts/check-migrations.sh --static', () => {
  const run = (target: string) =>
    spawnSync('bash', [path.join(root, 'scripts/check-migrations.sh'), '--static', target], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, LANE: '' },
    });

  it('exits 0 on a clean folder without touching Docker', () => {
    write(
      GOOD,
      'create table public.things (id uuid primary key);\nalter table public.things enable row level security;\n'
    );
    const result = run(dir);
    expect(result.status, result.stderr + result.stdout).toBe(0);
  });

  it('exits 1 and names the file and the table when row-level security is missing', () => {
    write(GOOD, 'create table public.things (id uuid primary key);\n');
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain(GOOD);
    expect(result.stdout + result.stderr).toContain('public.things');
  });

  it('exits 0 on the repository migrations as they are now', () => {
    const result = run(path.join(root, 'supabase/migrations'));
    expect(result.status, result.stderr + result.stdout).toBe(0);
  });
});

describe('forward-only against a real git history', () => {
  // A scratch repository with its own copy of the tool: main holds one migration, a branch adds, edits and deletes.
  const git = (repo: string, ...args: string[]) =>
    spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], {
      cwd: repo,
      encoding: 'utf8',
    });
  const lint = (repo: string) =>
    spawnSync('node', ['scripts/lane.mjs', 'lint-migrations'], { cwd: repo, encoding: 'utf8' });
  const MERGED = '20261015090000_0001_merged.sql';
  const ADDED = '20261015100000_0002_added.sql';

  it('accepts an added migration and refuses an edited or a deleted one', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'jv-history-'));
    try {
      git(repo, 'init', '-q', '-b', 'main');
      mkdirSync(path.join(repo, 'scripts'));
      copyFileSync(path.join(root, 'scripts/lane.mjs'), path.join(repo, 'scripts/lane.mjs'));
      mkdirSync(path.join(repo, 'supabase/migrations'), { recursive: true });
      writeFileSync(path.join(repo, 'supabase/migrations', MERGED), 'select 1;\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'base');
      git(repo, 'checkout', '-q', '-b', 'lane');

      writeFileSync(path.join(repo, 'supabase/migrations', ADDED), 'select 2;\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'adds a migration');
      expect(lint(repo).status, 'an added migration').toBe(0);

      writeFileSync(path.join(repo, 'supabase/migrations', MERGED), 'select 99;\n');
      const edited = lint(repo);
      expect(edited.status, 'an edited merged migration').toBe(1);
      expect(edited.stderr).toContain(MERGED);
      expect(edited.stderr).toMatch(/already merged/);
      git(repo, 'checkout', '--', `supabase/migrations/${MERGED}`);

      rmSync(path.join(repo, 'supabase/migrations', MERGED));
      expect(lint(repo).status, 'a deleted merged migration').toBe(1);
      git(repo, 'checkout', '--', `supabase/migrations/${MERGED}`);
      expect(lint(repo).status, 'back to only an addition').toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
