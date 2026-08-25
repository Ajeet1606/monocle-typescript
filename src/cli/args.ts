export type Command = "run" | "help" | "version" | "error";

export interface ParsedArgs {
    command: Command;
    /** Target script, for `run`. */
    file?: string;
    /** Everything after the target — passed through untouched. */
    userArgs: string[];
    /** `--tsx` given before the target. */
    forceTsx: boolean;
    /** Explanation, when command is "error". */
    message?: string;
}

const USAGE = "Usage: monocle2ai run [--tsx] <file> [args...]";

/**
 * Parse CLI arguments. Only flags before the target file belong to Monocle;
 * everything after it is passed to the script, so a target with its own
 * `--tsx` flag still works.
 */
export function parseArgs(argv: string[]): ParsedArgs {
    const empty = { userArgs: [] as string[], forceTsx: false };

    if (argv.length === 0) {
        return { command: "help", ...empty };
    }

    const [head, ...rest] = argv;

    if (head === "--help" || head === "-h" || head === "help") {
        return { command: "help", ...empty };
    }
    if (head === "--version" || head === "-v") {
        return { command: "version", ...empty };
    }
    if (head !== "run") {
        return {
            command: "error",
            message: `Unknown command "${head}". ${USAGE}`,
            ...empty,
        };
    }

    let forceTsx = false;
    let index = 0;
    while (index < rest.length && rest[index] === "--tsx") {
        forceTsx = true;
        index++;
    }

    const file = rest[index];
    if (!file) {
        return {
            command: "error",
            message: `No file given. ${USAGE}`,
            userArgs: [],
            forceTsx,
        };
    }

    return {
        command: "run",
        file,
        userArgs: rest.slice(index + 1),
        forceTsx,
    };
}

export { USAGE };
