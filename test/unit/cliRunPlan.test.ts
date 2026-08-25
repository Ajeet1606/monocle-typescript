import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isTypeScriptFile,
  preloadFlagFor,
  needsTypeScriptCompiler,
  isCompilerError,
  projectDirFor,
  tsconfigHasPaths,
  buildRunPlan,
  findLocalBin,
  usesEsmSyntax,
  packageTypeFor,
  tsconfigNeedsBundler,
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

describe('isTypeScriptFile', () => {
  it.each(['agent.ts', 'page.tsx', 'a.mts', 'a.cts'])('treats %s as TypeScript', (f) => {
    expect(isTypeScriptFile(f)).toBe(true);
  });

  it.each(['agent.js', 'a.mjs', 'a.cjs'])('treats %s as JavaScript', (f) => {
    expect(isTypeScriptFile(f)).toBe(false);
  });
});

describe('preloadFlagFor', () => {
  // A CommonJS module loaded through the ESM loader hits import-in-the-middle's
  // sync-require path, which fails with "is not in cache". So the flag has to
  // follow the file's actual syntax, not just its extension.
  it('uses --require for .cts, which cannot go through the ESM loader', () => {
    expect(preloadFlagFor('agent.cts')).toBe('--require');
  });

  it('uses --require for .cjs', () => {
    expect(preloadFlagFor('agent.cjs')).toBe('--require');
  });

  it.each(['agent.mts', 'agent.mjs'])('uses --import for %s regardless of contents', (f) => {
    expect(preloadFlagFor(f, 'const a = require("a");')).toBe('--import');
  });

  it('uses --import for a .ts file written with ESM imports', () => {
    expect(preloadFlagFor('agent.ts', 'import OpenAI from "openai";')).toBe('--import');
  });

  it('uses --require for a .ts file written with require', () => {
    expect(preloadFlagFor('agent.ts', 'const a = require("a");')).toBe('--require');
  });

  it('uses --require for a .js file written with require', () => {
    expect(preloadFlagFor('agent.js', 'const a = require("a");')).toBe('--require');
  });

  it('uses --import for a .ts file with an export statement', () => {
    expect(preloadFlagFor('agent.ts', 'export const a = 1;')).toBe('--import');
  });

  it('defaults to --import when the contents are unknown', () => {
    expect(preloadFlagFor('agent.ts')).toBe('--import');
  });
});

describe('needsTypeScriptCompiler', () => {
  it('flags an enum, which Node cannot strip', () => {
    expect(needsTypeScriptCompiler('enum Level { Low, High }')).toBe(true);
  });

  it('flags an exported const enum', () => {
    expect(needsTypeScriptCompiler('export const enum E { A }')).toBe(true);
  });

  it('flags a namespace', () => {
    expect(needsTypeScriptCompiler('namespace Utils { export const a = 1; }')).toBe(true);
  });

  it('flags a decorator', () => {
    expect(needsTypeScriptCompiler('@Injectable()\nclass Service {}')).toBe(true);
  });

  it('flags a constructor parameter property', () => {
    expect(needsTypeScriptCompiler('class A { constructor(private x: number) {} }')).toBe(true);
  });

  it('does not flag ordinary type annotations, which Node strips fine', () => {
    expect(needsTypeScriptCompiler('const a: string = "x";\ninterface B { c: number }')).toBe(false);
  });

  it('does not flag plain imports', () => {
    expect(needsTypeScriptCompiler('import OpenAI from "openai";')).toBe(false);
  });

  it('does not flag the word enum inside a string', () => {
    expect(needsTypeScriptCompiler('const s = "an enum value";')).toBe(false);
  });

  it('does not flag an email-like @ inside an expression', () => {
    expect(needsTypeScriptCompiler('const to = "a@b.com";')).toBe(false);
  });
});

describe('isCompilerError', () => {
  it('recognises unsupported TypeScript syntax', () => {
    expect(isCompilerError('SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: enum')).toBe(true);
  });

  it('recognises an unresolved module, which is how path aliases fail', () => {
    expect(isCompilerError("Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@/lib'")).toBe(true);
  });

  it('does not treat an ordinary runtime error as a compiler problem', () => {
    expect(isCompilerError('TypeError: x is not a function')).toBe(false);
  });
});

describe('projectDirFor', () => {
  it('returns the directory of the nearest package.json', () => {
    write('packages/api/package.json', '{}');
    const file = write('packages/api/src/agent.ts');

    expect(projectDirFor(file)).toBe(path.join(root, 'packages/api'));
  });

  it('walks up to a parent package.json when there is no nearer one', () => {
    write('package.json', '{}');
    const file = write('src/deep/agent.ts');

    expect(projectDirFor(file)).toBe(root);
  });

  it("falls back to the file's own directory when no package.json exists", () => {
    const file = write('loose/agent.ts');

    expect(projectDirFor(file)).toBe(path.join(root, 'loose'));
  });
});

describe('tsconfigHasPaths', () => {
  it('detects path aliases, which Node cannot resolve', () => {
    write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }));

    expect(tsconfigHasPaths(root)).toBe(true);
  });

  it('returns false for a tsconfig without paths', () => {
    write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'es2022' } }));

    expect(tsconfigHasPaths(root)).toBe(false);
  });

  it('returns false when there is no tsconfig at all', () => {
    expect(tsconfigHasPaths(root)).toBe(false);
  });

  it('tolerates a malformed tsconfig rather than throwing', () => {
    write('tsconfig.json', '{ not json');

    expect(tsconfigHasPaths(root)).toBe(false);
  });
});

describe('buildRunPlan', () => {
  it('runs plain CommonJS JavaScript on node with the require preload', () => {
    write('package.json', '{}');
    const file = write('agent.js', 'const a = require("a");');

    const plan = buildRunPlan(file, []);

    expect(plan.runner).toBe('node');
    expect(plan.args).toEqual(['--require', 'monocle2ai/register', file]);
    expect(plan.cwd).toBe(root);
  });

  it('runs ESM JavaScript on node with the import preload', () => {
    write('package.json', JSON.stringify({ type: 'module' }));
    const file = write('agent.js', 'import a from "a";');

    const plan = buildRunPlan(file, []);

    expect(plan.args).toEqual(['--import', 'monocle2ai/register', file]);
  });

  it('runs ordinary TypeScript on node, since Node can strip plain types', () => {
    write('package.json', '{}');
    const file = write('agent.ts', 'const a: string = "x";');

    expect(buildRunPlan(file, []).runner).toBe('node');
  });

  it('chooses tsx when the file uses syntax Node cannot strip', () => {
    write('package.json', '{}');
    const file = write('agent.ts', 'enum Level { Low }');

    expect(buildRunPlan(file, []).runner).toBe('tsx');
  });

  it('chooses tsx when the project uses tsconfig path aliases', () => {
    write('package.json', '{}');
    write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }));
    const file = write('agent.ts', 'import { a } from "@/lib";');

    expect(buildRunPlan(file, []).runner).toBe('tsx');
  });

  it('does not force tsx for path aliases when the target is plain JavaScript', () => {
    write('package.json', '{}');
    write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }));
    const file = write('agent.js', 'const a = 1;');

    expect(buildRunPlan(file, []).runner).toBe('node');
  });

  it('honours an explicit tsx request', () => {
    write('package.json', '{}');
    const file = write('agent.ts', 'const a = 1;');

    expect(buildRunPlan(file, [], { forceTsx: true }).runner).toBe('tsx');
  });

  it('passes the user arguments after the script, so the target sees its own argv', () => {
    write('package.json', '{}');
    const file = write('agent.js');

    const plan = buildRunPlan(file, ['--query', 'hello world']);

    expect(plan.args).toEqual([
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
});

describe('findLocalBin', () => {
  it('finds a binary in the starting directory node_modules', () => {
    const bin = write('node_modules/.bin/tsx', '#!/bin/sh');

    expect(findLocalBin('tsx', root)).toBe(bin);
  });

  // npm hoists binaries to the workspace root, so a nested package's cwd will
  // not contain them.
  it('walks up to an ancestor node_modules, the way node resolution does', () => {
    const bin = write('node_modules/.bin/tsx', '#!/bin/sh');
    fs.mkdirSync(path.join(root, 'packages/api/src'), { recursive: true });

    expect(findLocalBin('tsx', path.join(root, 'packages/api/src'))).toBe(bin);
  });

  it('returns undefined when the binary is nowhere to be found', () => {
    fs.mkdirSync(path.join(root, 'empty'), { recursive: true });

    expect(findLocalBin('definitely-not-installed-xyz', path.join(root, 'empty'))).toBeUndefined();
  });
});

describe('usesEsmSyntax', () => {
  it('detects an export statement', () => {
    expect(usesEsmSyntax('export async function main() {}')).toBe(true);
  });

  it('detects an import statement', () => {
    expect(usesEsmSyntax('import OpenAI from "openai";')).toBe(true);
  });

  it('detects export default', () => {
    expect(usesEsmSyntax('export default function () {}')).toBe(true);
  });

  it('does not flag a file using only require and module.exports', () => {
    const text = 'const a = require("a");\nmodule.exports = { a };';

    expect(usesEsmSyntax(text)).toBe(false);
  });

  it('does not flag the word export inside a string', () => {
    expect(usesEsmSyntax('const s = "export this";')).toBe(false);
  });
});

describe('packageTypeFor', () => {
  it('reads an explicit commonjs type', () => {
    write('package.json', JSON.stringify({ type: 'commonjs' }));

    expect(packageTypeFor(root)).toBe('commonjs');
  });

  it('reads an explicit module type', () => {
    write('package.json', JSON.stringify({ type: 'module' }));

    expect(packageTypeFor(root)).toBe('module');
  });

  it('returns undefined when no type field is set', () => {
    write('package.json', JSON.stringify({ name: 'x' }));

    expect(packageTypeFor(root)).toBeUndefined();
  });
});

describe('buildRunPlan - ESM syntax inside an explicitly CommonJS package', () => {
  // Node strips types but cannot rewrite `export` into `exports.x`; that is a
  // transform, not an erasure. With an explicit "type": "commonjs" Node also
  // refuses to reparse the file as ESM, so it fails outright.
  it('chooses tsx when an explicitly-commonjs package uses export syntax', () => {
    write('package.json', JSON.stringify({ type: 'commonjs' }));
    const file = write('agent.ts', 'const a = require("a");\nexport function go() {}');

    expect(buildRunPlan(file, []).runner).toBe('tsx');
  });

  it('stays on node for an explicitly-commonjs package written purely in CommonJS', () => {
    write('package.json', JSON.stringify({ type: 'commonjs' }));
    const file = write('agent.ts', 'const a = require("a");\nmodule.exports = a;');

    expect(buildRunPlan(file, []).runner).toBe('node');
  });

  // A package with no "type" lets Node detect ESM syntax and reparse, which works.
  it('stays on node when the package has no type field', () => {
    write('package.json', JSON.stringify({ name: 'x' }));
    const file = write('agent.ts', 'import OpenAI from "openai";');

    expect(buildRunPlan(file, []).runner).toBe('node');
  });

  it('stays on node for a type:module package', () => {
    write('package.json', JSON.stringify({ type: 'module' }));
    const file = write('agent.ts', 'import OpenAI from "openai";');

    expect(buildRunPlan(file, []).runner).toBe('node');
  });

  it('chooses tsx for a .cts file using export syntax, which is always CommonJS', () => {
    write('package.json', JSON.stringify({ name: 'x' }));
    const file = write('agent.cts', 'export function go() {}');

    expect(buildRunPlan(file, []).runner).toBe('tsx');
  });
});

describe('isCompilerError - ESM syntax rejected by a CommonJS loader', () => {
  it("recognises an unexpected export token", () => {
    expect(isCompilerError("SyntaxError: Unexpected token 'export'")).toBe(true);
  });

  it('recognises an import statement outside a module', () => {
    expect(isCompilerError('SyntaxError: Cannot use import statement outside a module')).toBe(true);
  });

  it('still ignores an ordinary runtime error', () => {
    expect(isCompilerError('TypeError: undefined is not a function')).toBe(false);
  });
});

describe('tsconfigNeedsBundler', () => {
  // "bundler" resolution lets imports omit file extensions. Node's ESM loader
  // requires them, so such a project cannot run on plain node.
  it('detects bundler module resolution', () => {
    write('tsconfig.json', JSON.stringify({ compilerOptions: { moduleResolution: 'bundler' } }));

    expect(tsconfigNeedsBundler(root)).toBe(true);
  });

  it('is case-insensitive, since tsconfig values often are', () => {
    write('tsconfig.json', JSON.stringify({ compilerOptions: { moduleResolution: 'Bundler' } }));

    expect(tsconfigNeedsBundler(root)).toBe(true);
  });

  it('returns false for nodenext resolution', () => {
    write('tsconfig.json', JSON.stringify({ compilerOptions: { moduleResolution: 'NodeNext' } }));

    expect(tsconfigNeedsBundler(root)).toBe(false);
  });

  it('returns false when there is no tsconfig', () => {
    expect(tsconfigNeedsBundler(root)).toBe(false);
  });
});

describe('buildRunPlan - bundler-style projects', () => {
  it('chooses tsx when the project uses bundler module resolution', () => {
    write('package.json', JSON.stringify({ type: 'module' }));
    write('tsconfig.json', JSON.stringify({ compilerOptions: { moduleResolution: 'bundler' } }));
    const file = write('agent.ts', 'import { a } from "./thing";');

    expect(buildRunPlan(file, []).runner).toBe('tsx');
  });

  it('leaves plain JavaScript on node even in a bundler project', () => {
    write('package.json', JSON.stringify({ type: 'module' }));
    write('tsconfig.json', JSON.stringify({ compilerOptions: { moduleResolution: 'bundler' } }));
    const file = write('agent.js', 'const a = 1;');

    expect(buildRunPlan(file, []).runner).toBe('node');
  });
});

describe('resolveRunnerCommand', () => {
  it('runs node with the interpreter already executing this CLI', () => {
    expect(resolveRunnerCommand('node', root)).toEqual({
      bin: process.execPath,
      prefixArgs: [],
    });
  });

  it('prefers a tsx installed in the project', () => {
    const bin = write('node_modules/.bin/tsx', '#!/bin/sh');

    expect(resolveRunnerCommand('tsx', root)).toEqual({ bin, prefixArgs: [] });
  });

  // npx resolves tsx from a user-level cache (~/.npm/_npx) and leaves
  // package.json, the lockfile and node_modules untouched — verified.
  it('falls back to npx when tsx is not installed, rather than refusing to run', () => {
    expect(resolveRunnerCommand('tsx', root)).toEqual({
      bin: 'npx',
      prefixArgs: ['--yes', 'tsx'],
    });
  });

  it('reports whether the fallback is in use so the CLI can say so', () => {
    expect(resolveRunnerCommand('tsx', root).bin).toBe('npx');

    write('node_modules/.bin/tsx', '#!/bin/sh');
    expect(resolveRunnerCommand('tsx', root).bin).not.toBe('npx');
  });
});

describe('buildRunPlan - files that mix require() with ESM syntax', () => {
  // Node parses a typeless file as CommonJS first, then reparses it as ESM the
  // moment it spots module syntax. That rescue is what makes a pure-ESM file
  // work — and what breaks a file that also calls require(), since `require`
  // does not exist in ESM scope. tsx compiles both forms down to CommonJS.
  const MIXED = "require('dotenv/config');\nconst { a } = require('a');\nexport {};";

  it('chooses tsx for a typeless package whose file mixes require with export', () => {
    write('package.json', JSON.stringify({ name: 'x' }));
    const file = write('agent.ts', MIXED);

    expect(buildRunPlan(file, []).runner).toBe('tsx');
  });

  it('chooses tsx when the ESM marker is a bare `export {}` at the end of the file', () => {
    write('package.json', JSON.stringify({ name: 'x' }));
    const file = write('agent.ts', "const a = require('a');\na();\nexport {};");

    expect(buildRunPlan(file, []).runner).toBe('tsx');
  });

  it('chooses tsx for a type:module package whose file calls require', () => {
    write('package.json', JSON.stringify({ type: 'module' }));
    const file = write('agent.ts', "const a = require('a');\nexport {};");

    expect(buildRunPlan(file, []).runner).toBe('tsx');
  });

  it('chooses tsx for a type:module package written entirely in CommonJS', () => {
    // No ESM syntax to trigger a reparse, but "type": "module" already forces
    // ESM, so require is undefined here too.
    write('package.json', JSON.stringify({ type: 'module' }));
    const file = write('agent.ts', "const a = require('a');\nmodule.exports = a;");

    expect(buildRunPlan(file, []).runner).toBe('tsx');
  });

  it('stays on node for a typeless package written purely in ESM', () => {
    write('package.json', JSON.stringify({ name: 'x' }));
    const file = write('agent.ts', "import OpenAI from 'openai';\nexport {};");

    expect(buildRunPlan(file, []).runner).toBe('node');
  });

  it('stays on node for a typeless package written purely in CommonJS', () => {
    write('package.json', JSON.stringify({ name: 'x' }));
    const file = write('agent.ts', "const a = require('a');\nmodule.exports = a;");

    expect(buildRunPlan(file, []).runner).toBe('node');
  });

  it('does not mistake the word require inside an identifier for a call', () => {
    write('package.json', JSON.stringify({ type: 'module' }));
    const file = write('agent.ts', "const requireAuth = true;\nexport { requireAuth };");

    expect(buildRunPlan(file, []).runner).toBe('node');
  });

  it('does not mistake a string mentioning require for a call', () => {
    write('package.json', JSON.stringify({ type: 'module' }));
    const file = write('agent.ts', "export const hint = 'use require() instead';");

    expect(buildRunPlan(file, []).runner).toBe('node');
  });
});
