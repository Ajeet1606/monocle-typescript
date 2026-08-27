import * as fs from "fs";
import * as path from "path";
import { consoleLog } from "./logging";

/** Monocle's own settings file, kept out of the app's .env. */
export const MONOCLE_ENV_FILE = ".env.monocle";

export type EnvFileOutcome = "loaded" | "absent" | "unsupported" | "failed";

/**
 * Load Monocle's settings from .env.monocle.
 *
 * Node applies --env-file before startup, so this only has to cover the
 * runtimes that never see that flag — Next.js and mastra load their own .env
 * and know nothing of this file. process.loadEnvFile leaves already-set
 * variables alone, which is the precedence we want: the real environment and
 * the app's own .env both outrank this file.
 *
 * Every failure is reported rather than thrown. The file is optional, and
 * tracing must not break because it is missing, unreadable, or unsupported.
 */
export function loadMonocleEnvFile(dir: string = process.cwd()): EnvFileOutcome {
    const file = path.join(dir, MONOCLE_ENV_FILE);

    // Added in Node 20.12 / 21.7; older runtimes simply go without.
    if (typeof process.loadEnvFile !== "function") {
        consoleLog(`[monocle] this Node cannot read ${MONOCLE_ENV_FILE}`);
        return "unsupported";
    }
    if (!fs.existsSync(file)) {
        return "absent";
    }

    try {
        process.loadEnvFile(file);
        consoleLog(`[monocle] loaded settings from ${file}`);
        return "loaded";
    } catch (err) {
        consoleLog(`[monocle] could not read ${file}: ${String(err)}`);
        return "failed";
    }
}
