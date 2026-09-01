import { Context, SpanStatusCode, Tracer, context, trace } from "@opentelemetry/api";
import { Span } from "../../common/opentelemetryUtils";
import {
    MONOCLE_ACTIVE_SPAN_KEY,
    SCOPE_AGENTIC_INVOCATION,
    WrapperArguments,
} from "../../common/constants";
import { DefaultSpanHandler } from "../../common/spanHandler";
import { updateBaggageContextWithScopes } from "../../common/utils";
import { consoleLog } from "../../../common/logging";
import { AGENT } from "./entities/agentInvocation";
import { TOOL } from "./entities/tools";

// Turns the agents SDK's RunHooks lifecycle events into Monocle spans, since
// Runner.run exposes no per-agent method to patch. The Runner emits all of these
// on itself:
//   agent_start(runContext, agent, turnInput?)
//   agent_end(runContext, agent, output)
//   agent_handoff(runContext, fromAgent, toAgent)
//   agent_tool_start(runContext, agent, tool, { toolCall })
//   agent_tool_end(runContext, agent, tool, result, { toolCall })
//
// A delegating agent gets no agent_end — the handoff ends its activation.
//
// Spans take an explicit parent: a listener returns immediately, so it cannot
// wrap the agent's later work in a context.with frame.

const INVOCATION_SPAN_NAME = "openai_agents.agent";
const TOOL_SPAN_NAME = "openai_agents.tool";

interface InvocationRecord {
    span: Span;
    // Retained so attributes are read with this activation's scopes active, and
    // so tool spans nest under it.
    spanContext: Context;
    agent: any;
    turnInput: any;
    handoffFrom?: { fromAgent: string; fromAgentSpanId: string };
}

interface ToolRecord {
    span: Span;
    spanContext: Context;
    tool: any;
    toolCall: any;
    agent: any;
}

interface RunState {
    tracer: Tracer;
    element: WrapperArguments;
    // Absent when skipSpan suppressed the turn span; activations then parent to
    // whatever encloses them.
    turn?: Span;
    invocation?: InvocationRecord;
    // Written by agent_handoff, consumed by the next agent_start.
    pendingHandoff?: { fromAgent: string; fromAgentSpanId: string };
    // Keyed by toolCall.callId: tool calls can run in parallel and complete out
    // of order, so start/end correlate by id rather than by recency.
    tools: Map<string, ToolRecord>;
}

// Keyed by the SDK's RunContext: one instance per run, passed to every event.
// This identifies a run even when no turn span exists, and keeps concurrent runs
// on a shared Runner apart. Weak so state is collectable if cleanup never runs.
const runStates = new WeakMap<object, RunState>();

// Lets the turn span's postProcessSpan find its run to force-close what is still
// open. Only populated when there is a turn span.
const turnToRunContext = new Map<Span, object>();

// One listener set per Runner: the module-level run() reuses a singleton Runner,
// so attaching per call would leak listeners or detach them from a live run.
const wiredRunners = new WeakSet<object>();

const spanHandler = new DefaultSpanHandler();

// Safe to read from the active context: events are emitted synchronously inside
// the awaited call chain of the patched Runner.run, and AsyncHooksContextManager
// carries the context across those awaits.
function activeTurnSpan(): Span | undefined {
    const active = context.active();
    const monocleSpan = active.getValue(MONOCLE_ACTIVE_SPAN_KEY) as Span | undefined;
    return monocleSpan || (trace.getSpan(active) as Span | undefined);
}

// Resolves the run's state, creating it on the first event. Without a RunContext
// concurrent runs are indistinguishable, so emit nothing rather than risk
// cross-attributing spans.
function stateFor(runContext: any, element: WrapperArguments, tracer: Tracer):
    RunState | undefined {
    if (!runContext || typeof runContext !== "object") return undefined;
    let state = runStates.get(runContext);
    if (!state) {
        const turn = activeTurnSpan();
        state = { tracer, element, turn, tools: new Map() };
        runStates.set(runContext, state);
        if (turn) {
            turnToRunContext.set(turn, runContext);
        }
    }
    return state;
}

// Runs a bridge-created span through the same pipeline as a wrapped call, so
// entities, events and scope attributes behave identically.
function fillAndEnd(
    span: Span,
    spanContext: Context,
    state: RunState,
    outputProcessor: any,
    instance: any,
    args: any[],
    returnValue: any,
) {
    try {
        // context.with is required: scopes are read off the globally active
        // baggage (getScopesInternal), not from a context passed in.
        context.with(spanContext, () => {
            spanHandler.setDefaultMonocleAttributes({
                span,
                instance,
                args: args as any,
                element: state.element,
                sourcePath: "",
            });
            spanHandler.processSpan({
                span,
                instance,
                args: args as any,
                returnValue,
                outputProcessor,
                wrappedPackage: state.element.package,
            });
        });
    } catch (e) {
        consoleLog(`Warning: error filling agents span: ${e}`);
    } finally {
        span.end();
    }
}

function closeInvocation(state: RunState, result: Record<string, any>) {
    const invocation = state.invocation;
    if (!invocation) return;
    state.invocation = undefined;
    fillAndEnd(
        invocation.span,
        invocation.spanContext,
        state,
        [AGENT],
        invocation.agent,
        [invocation.agent, invocation.turnInput],
        {
            ...result,
            fromAgent: invocation.handoffFrom?.fromAgent,
            fromAgentSpanId: invocation.handoffFrom?.fromAgentSpanId,
        },
    );
}

function openInvocation(state: RunState, agent: any, turnInput: any) {
    // Without a turn span, fall back to the ambient context so the activation
    // lands under the app's own span, or starts a root span if there is none.
    const parentContext = state.turn
        ? trace.setSpan(context.active(), state.turn)
        : context.active();
    // Each activation is its own invocation scope. null → auto-generate.
    const spanContext = updateBaggageContextWithScopes(parentContext, {
        [SCOPE_AGENTIC_INVOCATION]: null,
    });
    const span = state.tracer.startSpan(INVOCATION_SPAN_NAME, {}, spanContext) as Span;
    state.invocation = {
        span,
        spanContext,
        agent,
        turnInput,
        handoffFrom: state.pendingHandoff,
    };
    state.pendingHandoff = undefined;
}

function closeTool(state: RunState, record: ToolRecord, result: Record<string, any>) {
    fillAndEnd(
        record.span,
        record.spanContext,
        state,
        [TOOL],
        record.tool,
        [record.toolCall, record.agent],
        result,
    );
}

// Tool spans nest under the calling agent, falling back to the turn if no
// activation is open.
function openTool(state: RunState, agent: any, tool: any, toolCall: any) {
    const invocation = state.invocation;
    const parentSpan = invocation?.span || state.turn;
    const baseContext = invocation?.spanContext || context.active();
    const spanContext = parentSpan
        ? trace.setSpan(baseContext, parentSpan)
        : baseContext;
    const span = state.tracer.startSpan(TOOL_SPAN_NAME, {}, spanContext) as Span;

    const callId = toolCall?.callId || toolCall?.id;
    const record: ToolRecord = { span, spanContext, tool, toolCall, agent };
    if (callId) {
        state.tools.set(String(callId), record);
    } else {
        // Nothing to correlate on, so close now rather than leak a span that
        // agent_tool_end could never match.
        closeTool(state, record, {});
    }
}

// Closes anything still open and drops the run's state.
export function endRun(turn: Span) {
    const runContext = turnToRunContext.get(turn);
    if (!runContext) return;
    turnToRunContext.delete(turn);
    const state = runStates.get(runContext);
    if (!state) return;
    runStates.delete(runContext);
    for (const record of state.tools.values()) {
        record.span.setStatus({
            code: SpanStatusCode.ERROR,
            message: "run ended before the tool completed",
        });
        closeTool(state, record, {});
    }
    state.tools.clear();
    if (state.invocation) {
        state.invocation.span.setStatus({
            code: SpanStatusCode.ERROR,
            message: "run ended before the agent completed",
        });
        closeInvocation(state, {});
    }
}

export function attachRunnerHooks(runner: any, element: WrapperArguments, tracer: Tracer) {
    if (!runner || typeof runner.on !== "function") return;
    if (wiredRunners.has(runner)) return;
    wiredRunners.add(runner);

    // A tracing failure must never break the app's run.
    const guard = (name: string, fn: () => void) => {
        try {
            fn();
        } catch (e) {
            consoleLog(`Warning: agents ${name} hook failed: ${e}`);
        }
    };

    runner.on("agent_start", (runContext: any, agent: any, turnInput?: any) => {
        guard("agent_start", () => {
            const state = stateFor(runContext, element, tracer);
            if (!state) return;
            // The SDK moved on without ending the previous activation.
            if (state.invocation) {
                closeInvocation(state, { handoffTo: agent?.name || "" });
            }
            openInvocation(state, agent, turnInput);
        });
    });

    runner.on("agent_end", (runContext: any, _agent: any, output: any) => {
        guard("agent_end", () => {
            const state = stateFor(runContext, element, tracer);
            if (!state) return;
            closeInvocation(state, { output });
        });
    });

    runner.on("agent_tool_start", (runContext: any, agent: any, tool: any, details: any) => {
        guard("agent_tool_start", () => {
            const state = stateFor(runContext, element, tracer);
            if (!state) return;
            openTool(state, agent, tool, details?.toolCall);
        });
    });

    runner.on("agent_tool_end", (runContext: any, _agent: any, _tool: any, result: any, details: any) => {
        guard("agent_tool_end", () => {
            const state = stateFor(runContext, element, tracer);
            if (!state) return;
            const callId = details?.toolCall?.callId || details?.toolCall?.id;
            const record = callId ? state.tools.get(String(callId)) : undefined;
            if (!record) return;
            state.tools.delete(String(callId));
            closeTool(state, record, { result });
        });
    });

    // Ends the delegating agent's activation, and holds its provenance for the
    // next agent_start — the delegated agent.
    runner.on("agent_handoff", (runContext: any, fromAgent: any, toAgent: any) => {
        guard("agent_handoff", () => {
            const state = stateFor(runContext, element, tracer);
            if (!state) return;
            // Read the span id before the span closes.
            const fromAgentSpanId = state.invocation?.span.spanContext().spanId;
            const fromName = fromAgent?.name || state.invocation?.agent?.name || "";
            closeInvocation(state, { handoffTo: toAgent?.name || "" });
            if (fromAgentSpanId) {
                state.pendingHandoff = { fromAgent: fromName, fromAgentSpanId };
            }
        });
    });
}
