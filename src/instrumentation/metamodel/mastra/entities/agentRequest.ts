import { SPAN_SUBTYPES } from "../../../common/constants";
import { getExceptionMessage } from "../../utils";

const MASTRA_AGENT_TYPE = "agent.mastra";

function extractContentText(content: any): string {
    if (content == null) return "";
    if (typeof content === "string") return content;
    const parts = Array.isArray(content) ? content : undefined;
    if (Array.isArray(parts)) {
        return parts
            .map((p: any) => (typeof p === "string" ? p : p?.text || ""))
            .filter((t: string) => t)
            .join(" ");
    }
    return "";
}

// Mastra's generate()/stream() take the messages as args[0]: a string, or an
// array of strings / message objects. The text lives on `.content` (string or
// text parts) OR `.parts` (AI SDK UI messages, e.g. from useChat / the Mastra
// playground). Normalize each to a {role: text} JSON string.
function extractUserInput(args: any[]): string[] {
    const messages = args?.[0];
    if (messages == null) return [];
    const arr = Array.isArray(messages) ? messages : [messages];
    const out: string[] = [];
    for (const m of arr) {
        if (typeof m === "string") {
            if (m) out.push(JSON.stringify({ user: m }));
            continue;
        }
        const role = m?.role || "user";
        const text = extractContentText(m?.content ?? m?.parts);
        if (text) out.push(JSON.stringify({ [role]: text }));
    }
    return out;
}

// Both generate() (returns FullOutput) and stream() (FullOutput resolved via
// getFullOutput() in the wrapper) expose the final text on `.text`.
function extractFinalText({ response, exception }: any): string {
    if (exception) return getExceptionMessage({ exception });
    const text = response?.text;
    return typeof text === "string" ? text : "";
}

export const AGENT_REQUEST = {
    "type": "agentic.turn",
    "subtype": SPAN_SUBTYPES.TURN,
    "attributes": [
        [
            {
                "_comment": "agent type",
                "attribute": "type",
                "accessor": function () {
                    return MASTRA_AGENT_TYPE;
                },
            },
            {
                "_comment": "name of the agent",
                "attribute": "name",
                "accessor": function ({ instance }: any) {
                    return instance?.name || instance?.id || instance?.constructor?.name || "";
                },
            },
        ],
    ],
    "events": [
        {
            "name": "data.input",
            "attributes": [
                {
                    "_comment": "user message(s) passed into agent.generate / agent.stream",
                    "attribute": "input",
                    "accessor": function ({ args }: any) {
                        return extractUserInput(args);
                    },
                },
            ],
        },
        {
            "name": "data.output",
            "attributes": [
                {
                    "_comment": "final assistant response for the turn",
                    "attribute": "response",
                    "accessor": function ({ response, exception }: any) {
                        return extractFinalText({ response, exception });
                    },
                },
            ],
        },
        // Token usage intentionally omitted: this is an agentic turn span, not
        // an inference span. Tokens belong on the future inference span.
    ],
};
