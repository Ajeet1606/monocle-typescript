import { MethodConfig } from "../../common/constants";
import { DefaultSpanHandler } from "../../common/spanHandler";
import { AGENT_REQUEST } from "./entities/agentRequest";
import { INFERENCE, INFERENCE_STREAM } from "./entities/inference";
import { MastraTurnSpanHandler } from "./mastraProcessor";

// Agent.generate() (one-shot) and Agent.stream() (streaming) are exported
// prototype methods on the singleton Agent class; @mastra/core/agent is the
// only specifier that exports Agent (the package root exports only Mastra).
// Patching here covers direct app usage AND Mastra's internally-created agents.
// Each call is one agentic turn.
const MASTRA_AGENT_PACKAGE = "@mastra/core/agent";

// Mastra normalizes every model (router strings AND raw AI-SDK objects) into an
// AI-SDK LanguageModelV2 wrapper. ModelRouterLanguageModel (exported from
// @mastra/core/llm) is the single choke point: generate()/stream() → the agentic
// loop → model.doGenerate()/doStream(). One wrap per method = one inference span
// per LLM call, for every provider (read off modelId / provider).
const MASTRA_LLM_PACKAGE = "@mastra/core/llm";

export const config: MethodConfig[] = [
    {
        package: MASTRA_AGENT_PACKAGE,
        object: "Agent",
        method: "generate",
        spanName: "mastra.agent.generate",
        spanHandler: new MastraTurnSpanHandler(),
        output_processor: [AGENT_REQUEST],
    } as unknown as MethodConfig,
    {
        package: MASTRA_AGENT_PACKAGE,
        object: "Agent",
        method: "stream",
        spanName: "mastra.agent.stream",
        spanHandler: new MastraTurnSpanHandler(),
        output_processor: [AGENT_REQUEST],
    } as unknown as MethodConfig,
    {
        // DefaultSpanHandler: used when the span is not part of a larger agentic turn (e.g. when the LLM is called directly, outside of an agentic loop). This ensures that the span is still created and processed correctly, even if it is not part of a larger agentic turn.
        // (NOT NonFrameworkSpanHandler): used when the span is part of a larger agentic turn (e.g. when the LLM is called from within an agentic loop). This ensures that the span is created and processed correctly, and that it is linked to the parent span of the agentic turn.
        // here our span is part of a larger agentic turn but mastra doesn't emit any inference spans for the LLM call, so we use DefaultSpanHandler to ensure that the span is still created and processed correctly.
        
        package: MASTRA_LLM_PACKAGE,
        object: "ModelRouterLanguageModel",
        method: "doGenerate",
        spanName: "mastra.model.generate",
        spanHandler: new DefaultSpanHandler(),
        output_processor: [INFERENCE],
    } as unknown as MethodConfig,
    {
        // Streaming counterpart (agent.stream()): INFERENCE_STREAM's
        // response_processor observes the returned stream and defers the span
        // until it closes. See entities/inference.ts.
        package: MASTRA_LLM_PACKAGE,
        object: "ModelRouterLanguageModel",
        method: "doStream",
        spanName: "mastra.model.stream",
        spanHandler: new DefaultSpanHandler(),
        output_processor: [INFERENCE_STREAM],
    } as unknown as MethodConfig,
];
