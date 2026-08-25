import * as fs from "fs";
import * as path from "path";

export type PreloadFlag = "--import" | "--require";
export type Runner = "node" | "tsx";

export interface RunPlan {
    /** Executable to spawn. */
    runner: Runner;
    /** Full argument list, preload flag first and user args last. */
    args: string[];
    /** Directory to run from — tsconfig discovery and module resolution depend on it. */
    cwd: string;
}

export interface RunPlanOptions {
    /** Skip the heuristics and use tsx regardless. */
    forceTsx?: boolean;
}

const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
// Extensions Node always loads through the CommonJS require hook. A .cts entry
// additionally breaks inside import-in-the-middle when loaded via --import.
const COMMONJS_EXTENSIONS = [".cts", ".cjs"];
// Extensions that always mean ESM, whatever the file contains.
const ESM_EXTENSIONS = [".mts", ".mjs"];

// TypeScript that Node's strip-only mode cannot run, because each needs code to
// be generated rather than erased.
const NEEDS_COMPILER = [
    /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+\w/m,
    /^\s*(?:export\s+)?(?:declare\s+)?namespace\s+\w/m,
    /^\s*@\w+/m,
    /constructor\s*\([^)]*\b(?:private|public|protected|readonly)\b/,
];

// Startup failures that mean "this needs a real TypeScript compiler":
// unsupported syntax, or a path alias Node cannot resolve.
const COMPILER_ERROR_CODES = [
    "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
    "ERR_MODULE_NOT_FOUND",
    // ESM syntax reaching a CommonJS loader. Turning `export` into
    // `exports.x` is a transform, which Node's strip-only mode will not do.
    "Unexpected token 'export'",
    "Cannot use import statement outside a module",
];

export function isTypeScriptFile(filePath: string): boolean {
    return TYPESCRIPT_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

/**
 * Which preload flag to use. `--import` routes the entry through the ESM loader,
 * where a CommonJS module hits import-in-the-middle's sync-require path and dies
 * with "is not in cache". A pinning extension wins; otherwise syntax decides.
 */
export function preloadFlagFor(filePath: string, fileText = ""): PreloadFlag {
    const ext = path.extname(filePath).toLowerCase();
    if (COMMONJS_EXTENSIONS.includes(ext)) {
        return "--require";
    }
    if (ESM_EXTENSIONS.includes(ext)) {
        return "--import";
    }
    // Unknown contents default to --import: most agent files are ESM, and that
    // is the path with working TypeScript support.
    return !fileText || usesEsmSyntax(fileText) ? "--import" : "--require";
}

export function needsTypeScriptCompiler(fileText: string): boolean {
    return NEEDS_COMPILER.some((pattern) => pattern.test(fileText));
}

export function isCompilerError(output: string): boolean {
    return COMPILER_ERROR_CODES.some((code) => output.includes(code));
}

/** Directory of the nearest package.json, or the file's own directory. */
export function projectDirFor(filePath: string): string {
    const fileDir = path.dirname(path.resolve(filePath));
    let dir = fileDir;
    for (;;) {
        if (fs.existsSync(path.join(dir, "package.json"))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return fileDir;
        }
        dir = parent;
    }
}

/**
 * Whether the nearest tsconfig declares path aliases. Node never reads
 * tsconfig, so an aliased import fails there and needs tsx.
 */
export function tsconfigHasPaths(startDir: string): boolean {
    let dir = path.resolve(startDir);
    for (;;) {
        const candidate = path.join(dir, "tsconfig.json");
        if (fs.existsSync(candidate)) {
            const text = readOrEmpty(candidate);
            try {
                const config = JSON.parse(text);
                return Object.keys(config?.compilerOptions?.paths ?? {}).length > 0;
            } catch {
                // tsconfig files routinely carry comments, which JSON.parse
                // rejects. Fall back to looking for the key itself.
                return /"paths"\s*:/.test(text);
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return false;
        }
        dir = parent;
    }
}

/**
 * Locate an executable installed by npm, walking up from `startDir` the way
 * module resolution does — package managers hoist binaries to the workspace
 * root, so a nested package's own directory often will not hold them.
 */
export function findLocalBin(name: string, startDir: string): string | undefined {
    const binName = process.platform === "win32" ? `${name}.cmd` : name;
    let dir = path.resolve(startDir);
    for (;;) {
        const candidate = path.join(dir, "node_modules", ".bin", binName);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
}

function readOrEmpty(filePath: string): string {
    try {
        return fs.readFileSync(filePath, "utf8");
    } catch {
        return "";
    }
}

/** Parsed compilerOptions of the nearest tsconfig, as far as we can read it. */
function nearestCompilerOptions(startDir: string): Record<string, unknown> | undefined {
    let dir = path.resolve(startDir);
    for (;;) {
        const candidate = path.join(dir, "tsconfig.json");
        if (fs.existsSync(candidate)) {
            try {
                return JSON.parse(readOrEmpty(candidate))?.compilerOptions ?? {};
            } catch {
                return undefined;
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
}

/**
 * Whether the project relies on bundler-style module resolution, which permits
 * extensionless relative imports. Node's ESM loader demands extensions, so
 * these projects cannot run on plain node.
 */
export function tsconfigNeedsBundler(startDir: string): boolean {
    const options = nearestCompilerOptions(startDir);
    const resolution = options?.moduleResolution;
    return typeof resolution === "string" && resolution.toLowerCase() === "bundler";
}


// A top-level `import` or `export` statement, as opposed to a dynamic
// `import(...)` call or the words appearing inside a string.
const ESM_SYNTAX = /^[ \t]*(?:export\s+(?:default\s+)?[{*a-zA-Z_$]|import\s*[{*'"._$a-zA-Z])/m;

export function usesEsmSyntax(fileText: string): boolean {
    return ESM_SYNTAX.test(fileText);
}

// Comments and string literals, so a file that merely talks about require()
// is not mistaken for one that calls it.
const COMMENT_OR_STRING =
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;

// A require() call. Excludes a preceding word character or dot, so neither
// `requireAuth` nor `foo.require(...)` counts.
const REQUIRE_CALL = /(?:^|[^.\w$])require\s*\(/;

/** Whether a file calls require(), which does not exist in ES module scope. */
export function usesRequire(fileText: string): boolean {
    return REQUIRE_CALL.test(fileText.replace(COMMENT_OR_STRING, " "));
}

/** The `type` field of the nearest package.json, if it sets one. */
export function packageTypeFor(startDir: string): string | undefined {
    let dir = path.resolve(startDir);
    for (;;) {
        const candidate = path.join(dir, "package.json");
        if (fs.existsSync(candidate)) {
            try {
                return JSON.parse(readOrEmpty(candidate))?.type;
            } catch {
                return undefined;
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
}

function chooseRunner(
    filePath: string,
    cwd: string,
    options: RunPlanOptions
): Runner {
    if (options.forceTsx) {
        return "tsx";
    }
    // Plain JavaScript never needs a compiler, whatever the project config.
    if (!isTypeScriptFile(filePath)) {
        return "node";
    }
    const text = readOrEmpty(filePath);
    if (needsTypeScriptCompiler(text)) {
        return "tsx";
    }
    // A package that declares "commonjs" (or a .cts file) never gets Node's
    // detect-and-reparse rescue, so ESM syntax there is a hard failure.
    const ext = path.extname(filePath).toLowerCase();
    const packageType = packageTypeFor(cwd);
    const alwaysCommonJs = ext === ".cts" || packageType === "commonjs";
    if (alwaysCommonJs && usesEsmSyntax(text)) {
        return "tsx";
    }
    // The mirror image: `require` does not exist in ESM scope. Node loads the
    // file as ESM when the extension or package says so, and also when it
    // reparses a typeless file after spotting module syntax. tsx handles both.
    const loadedAsEsm =
        ext === ".mts" ||
        packageType === "module" ||
        (!alwaysCommonJs && usesEsmSyntax(text));
    if (loadedAsEsm && usesRequire(text)) {
        return "tsx";
    }
    if (tsconfigHasPaths(cwd) || tsconfigNeedsBundler(cwd)) {
        return "tsx";
    }
    return "node";
}

export interface RunnerCommand {
    /** Executable to spawn. */
    bin: string;
    /** Arguments that must precede the run arguments (used by the npx fallback). */
    prefixArgs: string[];
}

/**
 * Resolve how to invoke a runner. When tsx is not installed we fall back to
 * `npx --yes tsx` rather than refusing: npx serves it from a user-level cache
 * and leaves package.json, the lockfile and node_modules untouched.
 */
export function resolveRunnerCommand(runner: Runner, cwd: string): RunnerCommand {
    if (runner === "node") {
        return { bin: process.execPath, prefixArgs: [] };
    }
    const local = findLocalBin("tsx", cwd);
    return local
        ? { bin: local, prefixArgs: [] }
        : { bin: "npx", prefixArgs: ["--yes", "tsx"] };
}

/**
 * Decide how to run `filePath` with Monocle tracing preloaded.
 *
 * Node runs most TypeScript directly by stripping types, so it is the default;
 * tsx is used only where Node provably cannot cope.
 */
export function buildRunPlan(
    filePath: string,
    userArgs: string[],
    options: RunPlanOptions = {}
): RunPlan {
    const resolved = path.resolve(filePath);
    const cwd = projectDirFor(resolved);
    const text = readOrEmpty(resolved);
    return {
        runner: chooseRunner(resolved, cwd, options),
        args: [
            preloadFlagFor(resolved, text),
            "monocle2ai/register",
            resolved,
            ...userArgs,
        ],
        cwd,
    };
}
