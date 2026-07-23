import { MethodConfig } from "../../common/constants";
import { AGENT_REQUEST } from "./entities/agentRequest";
import { MastraTurnSpanHandler } from "./mastraProcessor";

// Agent.generate() (one-shot) and Agent.stream() (streaming) are exported
// prototype methods on the singleton Agent class; @mastra/core/agent is the
// only specifier that exports Agent (the package root exports only Mastra).
// Patching here covers direct app usage AND Mastra's internally-created agents.
// Each call is one agentic turn.
const MASTRA_AGENT_PACKAGE = "@mastra/core/agent";

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
];
