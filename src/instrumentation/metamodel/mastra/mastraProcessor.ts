import { context } from "@opentelemetry/api";
import {
    MASTRA_TURN_SPAN_ACTIVE_KEY,
    SCOPE_AGENTIC_SESSION,
    SCOPE_AGENTIC_TURN,
    WrapperArguments,
} from "../../common/constants";
import { DefaultSpanHandler } from "../../common/spanHandler";
import { getScopeFromContext, updateBaggageContextWithScopes } from "../../common/utils";

// Best-effort read of an app-supplied session/thread id from the agent call
// options (args[1]). Monocle never fabricates one — if the app doesn't pass it,
// the session scope stays unset. Field names mirror Mastra's memory options;
// confirm against the installed @mastra/core version during the e2e in Task 4.
function extractSessionId(callArgs: any): string | undefined {
    const options = callArgs?.[1];
    if (!options) return undefined;
    const thread = options.memory?.thread;
    if (typeof thread === "string") return thread;
    if (typeof thread?.id === "string") return thread.id;
    if (typeof options.threadId === "string") return options.threadId;
    if (typeof options.resourceId === "string") return options.resourceId;
    return undefined;
}

export class MastraTurnSpanHandler extends DefaultSpanHandler {
    // Suppress duplicate agentic.turn spans. The outermost generate()/stream()
    // call opens the turn span and stamps MASTRA_TURN_SPAN_ACTIVE_KEY; any
    // nested agent invocation sees the key and bails out before opening its own
    // span. The original method still runs — only span creation is skipped.
    skipSpan(): boolean {
        return context.active().getValue(MASTRA_TURN_SPAN_ACTIVE_KEY) === true;
    }

    preTracing(_: WrapperArguments, currentContext: any, _thisArg?: any, callArgs?: any): any {
        currentContext = currentContext.setValue(MASTRA_TURN_SPAN_ACTIVE_KEY, true);

        const scopes: Record<string, string | null> = {};
        // Session comes from the app; never overwrite an inherited one, never
        // synthesize a missing one.
        const sessionId = extractSessionId(callArgs);
        if (!getScopeFromContext(currentContext, SCOPE_AGENTIC_SESSION) && sessionId) {
            scopes[SCOPE_AGENTIC_SESSION] = sessionId;
        }
        // Turn: one agent call → one turn id. Only generate when nothing's on
        // the context (outermost call wins), so nested calls share the id.
        if (!getScopeFromContext(currentContext, SCOPE_AGENTIC_TURN)) {
            scopes[SCOPE_AGENTIC_TURN] = null; // null → auto-generate id
        }

        currentContext = updateBaggageContextWithScopes(currentContext, scopes);
        return currentContext;
    }

    // stream() returns a MastraModelOutput synchronously, before generation
    // finishes. getFullOutput() resolves when the run completes and yields the
    // aggregated FullOutput ({ text, ... }); it is non-destructive (Mastra
    // buffers/replays chunks so the app can still read its own textStream).
    // The common wrapper (Task 3) uses this to defer ending the span until the
    // stream is done. generate() returns a Promise and does not need this.
    resolveCompletion({ returnValue }: { returnValue: any }): Promise<any> | null {
        if (returnValue && typeof returnValue.getFullOutput === "function") {
            return returnValue.getFullOutput();
        }
        return null;
    }
}
