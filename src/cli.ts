import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { parseArgs, USAGE } from "./cli/args";
import {
    buildRunPlan,
    isCompilerError,
    isTypeScriptFile,
    resolveRunnerCommand,
    RunPlan,
} from "./cli/runPlan";
import { MONOCLE_VERSION } from "./instrumentation/common/monocle_version";

const HELP = `monocle2ai — run a script with Monocle tracing enabled.

${USAGE}

  --tsx        Force the tsx runner instead of letting Node run the file.
  --version    Print the Monocle version.
  --help       Show this message.

Tracing is preloaded before your code runs, so the target file needs no edits.
Set MONOCLE_WORKFLOW_NAME to name the workflow (defaults to the package name).`;

interface RunOutcome {
    code: number;
    stderr: string;
    spawnFailed: boolean;
}

/**
 * Run one attempt. stdin/stdout are inherited so the script stays interactive;
 * stderr is echoed through but also captured, so a startup failure can be
 * recognised without hiding it from the user.
 */
function runOnce(plan: RunPlan): Promise<RunOutcome> {
    return new Promise((resolve) => {
        const command = resolveRunnerCommand(plan.runner, plan.cwd);
        if (command.bin === "npx") {
            console.error(
                "[monocle] tsx is not installed here; running it through npx. " +
                "Your project is left untouched."
            );
        }
        const child = spawn(command.bin, [...command.prefixArgs, ...plan.args], {
            cwd: plan.cwd,
            stdio: ["inherit", "inherit", "pipe"],
            env: process.env,
        });

        let stderr = "";
        child.stderr?.on("data", (chunk) => {
            const text = chunk.toString();
            stderr += text;
            process.stderr.write(text);
        });
        child.on("error", (err) => {
            resolve({ code: 1, stderr: `${stderr}${err.message}`, spawnFailed: true });
        });
        child.on("close", (code) => {
            resolve({ code: code ?? 1, stderr, spawnFailed: false });
        });
    });
}

/**
 * `monocle2ai run` is the only interface a user should need, so this points
 * back at the same command rather than at the preload it uses internally.
 */
export function missingTsxMessage(file: string, detail = ""): string {
    return (
        `[monocle] ${path.basename(file)} needs the tsx runner to compile it, ` +
        "and it could not be started.\n" +
        (detail ? `          ${detail.trim()}\n` : "") +
        "          Install it:  npm install -D tsx\n" +
        `          Then re-run:  npx monocle2ai run ${file}`
    );
}

function reportMissingTsx(file: string, detail = ""): void {
    console.error(missingTsxMessage(file, detail));
}

export async function main(argv: string[]): Promise<number> {
    const parsed = parseArgs(argv);

    if (parsed.command === "help") {
        console.log(HELP);
        return 0;
    }
    if (parsed.command === "version") {
        console.log(MONOCLE_VERSION);
        return 0;
    }
    if (parsed.command === "error") {
        console.error(parsed.message);
        return 1;
    }

    const file = parsed.file as string;
    if (!fs.existsSync(file)) {
        console.error(`File not found: ${file}`);
        return 1;
    }

    const plan = buildRunPlan(file, parsed.userArgs, { forceTsx: parsed.forceTsx });
    const first = await runOnce(plan);
    if (first.spawnFailed) {
        reportMissingTsx(file, first.stderr);
        return 1;
    }
    const canRetry =
        first.code !== 0 &&
        plan.runner === "node" &&
        isTypeScriptFile(file) &&
        isCompilerError(first.stderr);

    if (!canRetry) {
        return first.code;
    }

    // Node's type stripping cannot generate code or resolve tsconfig paths.
    // Both failures happen at startup, before the script does any work, so
    // re-running is safe.
    console.error(
        "\n[monocle] Node could not run this TypeScript file directly. Retrying with tsx..."
    );
    const retryPlan = buildRunPlan(file, parsed.userArgs, { forceTsx: true });
    const second = await runOnce(retryPlan);
    if (second.spawnFailed) {
        reportMissingTsx(file, second.stderr);
        return first.code;
    }
    return second.code;
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
    process.exitCode = await main(argv);
}
