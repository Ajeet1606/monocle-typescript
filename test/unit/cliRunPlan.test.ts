import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  preloadFlagFor,
  projectDirFor,
  buildRunPlan,
  findLocalBin,
  resolveRunnerCommand,
} from '../../src/cli/runPlan';

let root: string;
const write = (rel: string, body = '') => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'monocle-cli-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('preloadFlagFor', () => {
  // tsx compiles the target whatever its module system, so the flag no longer
  // depends on the package type or the file's own syntax — only on .cts, which
  // import-in-the-middle cannot load through --import.
  it.each(['agent.ts', 'agent.tsx', 'agent.js', 'agent.mjs', 'agent.mts', 'agent.cjs'])(
    'uses the import preload for %s',
    (f) => {
      expect(preloadFlagFor(f)).toBe('--import');
    }
  );

  it('uses the require preload for .cts, which breaks IITM under --import', () => {
    expect(preloadFlagFor('agent.cts')).toBe('--require');
  });

  it('ignores the case of the extension', () => {
    expect(preloadFlagFor('AGENT.CTS')).toBe('--require');
  });

  it('does not depend on the file contents', () => {
    // A path that does not exist still yields a flag — nothing is read.
    expect(preloadFlagFor('/nowhere/agent.ts')).toBe('--import');
  });
});

describe('projectDirFor', () => {
  it('returns the directory holding the nearest package.json', () => {
    write('package.json', '{}');
    const file = write('src/agent.ts');

    expect(projectDirFor(file)).toBe(root);
  });

  it('prefers a nested package.json over one further up', () => {
    write('package.json', '{}');
    write('packages/api/package.json', '{}');
    const file = write('packages/api/src/agent.ts');

    expect(projectDirFor(file)).toBe(path.join(root, 'packages/api'));
  });

  it("falls back to the file's own directory when there is no package.json", () => {
    const file = path.join(root, 'loose', 'agent.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');

    expect(projectDirFor(file)).toBe(path.join(root, 'loose'));
  });
});

describe('buildRunPlan', () => {
  it('preloads tracing ahead of the target file', () => {
    write('package.json', '{}');
    const file = write('agent.ts', 'const a: string = "x";');

    expect(buildRunPlan(file, []).args).toEqual([
      '--import',
      'monocle2ai/register',
      file,
    ]);
  });

  it('runs from the project directory, so tsconfig and node_modules resolve', () => {
    write('package.json', '{}');
    const file = write('src/agent.ts');

    expect(buildRunPlan(file, []).cwd).toBe(root);
  });

  it('passes the user arguments after the script, so the target sees its own argv', () => {
    write('package.json', '{}');
    const file = write('agent.ts');

    expect(buildRunPlan(file, ['--query', 'hello world']).args).toEqual([
      '--import',
      'monocle2ai/register',
      file,
      '--query',
      'hello world',
    ]);
  });

  it('uses the require preload for a .cts target', () => {
    write('package.json', '{}');
    const file = write('agent.cts', 'const a = require("a");');

    expect(buildRunPlan(file, []).args[0]).toBe('--require');
  });

  it('resolves a relative path, since the child runs from the project directory', () => {
    write('package.json', '{}');
    write('agent.ts');
    const plan = buildRunPlan(path.join(root, '.', 'agent.ts'), []);

    expect(path.isAbsolute(plan.args[2])).toBe(true);
  });

  // Every module system and TypeScript feature goes through the same plan —
  // these all failed on plain node before, and the runner no longer varies.
  it.each([
    ['enum syntax node cannot strip', 'agent.ts', 'enum Level { Low }'],
    ['an explicitly-commonjs file using export', 'agent.ts', 'const a = require("a");\nexport {};'],
    ['a pure ESM file', 'agent.ts', 'import a from "a";'],
    ['plain JavaScript', 'agent.js', 'const a = require("a");'],
  ])('handles %s without a separate runner decision', (_label, name, body) => {
    write('package.json', '{}');
    const file = write(name, body);

    expect(buildRunPlan(file, []).args[0]).toBe('--import');
  });
});

describe('findLocalBin', () => {
  it('finds a binary in the starting directory', () => {
    const bin = write('node_modules/.bin/tsx', '#!/bin/sh');

    expect(findLocalBin('tsx', root)).toBe(bin);
  });

  it('walks up to a hoisted binary, as module resolution does', () => {
    const bin = write('node_modules/.bin/tsx', '#!/bin/sh');
    const nested = path.join(root, 'packages/api');
    fs.mkdirSync(nested, { recursive: true });

    expect(findLocalBin('tsx', nested)).toBe(bin);
  });

  it('returns undefined when the binary is nowhere up the tree', () => {
    expect(findLocalBin('tsx', root)).toBeUndefined();
  });
});

describe('resolveRunnerCommand', () => {
  it('prefers a tsx installed in the project', () => {
    const bin = write('node_modules/.bin/tsx', '#!/bin/sh');

    expect(resolveRunnerCommand(root)).toEqual({ bin, prefixArgs: [] });
  });

  // npx resolves tsx from a user-level cache (~/.npm/_npx) and leaves
  // package.json, the lockfile and node_modules untouched — verified.
  it('falls back to npx when tsx is not installed, rather than refusing to run', () => {
    expect(resolveRunnerCommand(root)).toEqual({
      bin: 'npx',
      prefixArgs: ['--yes', 'tsx'],
    });
  });

  it('reports whether the fallback is in use so the CLI can say so', () => {
    expect(resolveRunnerCommand(root).bin).toBe('npx');

    write('node_modules/.bin/tsx', '#!/bin/sh');
    expect(resolveRunnerCommand(root).bin).not.toBe('npx');
  });
});
