import * as fs from "fs";
import * as path from "path";

export type PreloadFlag = "--import" | "--require";

export interface RunPlan {
    /** Full argument list, preload flag first and user args last. */
    args: string[];
    /** Directory to run from — tsconfig discovery and module resolution depend on it. */
    cwd: string;
}

// The one target import-in-the-middle cannot take through --import: it throws
// "is not in cache". Every other extension loads correctly that way under tsx.
const REQUIRE_PRELOAD_EXTENSIONS = [".cts"];

/**
 * Which preload flag to use. tsx compiles the target either way, so the file's
 * own module system no longer matters — only .cts needs --require.
 */
export function preloadFlagFor(filePath: string): PreloadFlag {
    const ext = path.extname(filePath).toLowerCase();
    return REQUIRE_PRELOAD_EXTENSIONS.includes(ext) ? "--require" : "--import";
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

export interface RunnerCommand {
    /** Executable to spawn. */
    bin: string;
    /** Arguments that must precede the run arguments (used by the npx fallback). */
    prefixArgs: string[];
}

/**
 * Resolve how to invoke tsx. When it is not installed we fall back to
 * `npx --yes tsx` rather than refusing: npx serves it from a user-level cache
 * and leaves package.json, the lockfile and node_modules untouched.
 */
export function resolveRunnerCommand(cwd: string): RunnerCommand {
    const local = findLocalBin("tsx", cwd);
    return local
        ? { bin: local, prefixArgs: [] }
        : { bin: "npx", prefixArgs: ["--yes", "tsx"] };
}

/**
 * Decide how to run `filePath` with Monocle tracing preloaded. Everything goes
 * through tsx: it handles every module system and TypeScript feature Node's
 * strip-only mode cannot, for ~170ms against a multi-second tracing startup.
 */
export function buildRunPlan(filePath: string, userArgs: string[]): RunPlan {
    const resolved = path.resolve(filePath);
    return {
        args: [
            preloadFlagFor(resolved),
            "monocle2ai/register",
            resolved,
            ...userArgs,
        ],
        cwd: projectDirFor(resolved),
    };
}
