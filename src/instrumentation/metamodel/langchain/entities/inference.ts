import { INFERENCE_TOOL_CALL, INFERENCE_TURN_END, SPAN_TYPES } from "../../../common/constants";
import { mapLangchainFinishReasonToFinishType } from "../../finishType";
import {
  extractAssistantMessage,
  getExceptionMessage,
  getLlmMetadata,
} from "../../utils";


// Maps a langchain chat model's identity signals to Monocle's canonical provider
// key. Needed because langchain's names don't match our taxonomy: e.g. Gemini
// reports "googlegenerativeai" and Bedrock "bedrock", but native-SDK spans use
// "gemini" and "aws_bedrock". Without this mapping the same provider would show
// two different `inference.*` types depending on whether it was called via
// langchain or its native SDK, breaking grouping by provider.
const PROVIDER_ALIASES: Record<string, string> = {
  // OpenAI
  openai: "openai",
  chatopenai: "openai",
  // Azure OpenAI
  azure_openai: "azure_openai",
  azureopenai: "azure_openai",
  azurechatopenai: "azure_openai",
  // Anthropic
  anthropic: "anthropic",
  chatanthropic: "anthropic",
  // Google Gemini (Generative AI)
  gemini: "gemini",
  googlegenerativeai: "gemini",
  google_genai: "gemini",
  chatgooglegenerativeai: "gemini",
  // Google Vertex AI
  vertexai: "vertexai",
  google_vertexai: "vertexai",
  chatvertexai: "vertexai",
  // AWS Bedrock
  bedrock: "aws_bedrock",
  aws_bedrock: "aws_bedrock",
  bedrockchat: "aws_bedrock",
  chatbedrock: "aws_bedrock",
  chatbedrockconverse: "aws_bedrock",
};

// Returns a canonical provider key for a chat model, or "" if undetermined.
// Signals, most reliable first: _llmType() (distinguishes Azure), lc_namespace,
// then constructor name.
function detectProvider(instance): string {
  try {
    if (!instance) {
      return "";
    }
    const signals: string[] = [];
    if (typeof instance._llmType === "function") {
      try {
        signals.push(instance._llmType());
      } catch (e) {
        // _llmType() can throw before init; ignore and fall through
      }
    }
    if (Array.isArray(instance.lc_namespace) && instance.lc_namespace.length) {
      signals.push(instance.lc_namespace[instance.lc_namespace.length - 1]);
    }
    if (instance.constructor && instance.constructor.name) {
      signals.push(instance.constructor.name);
    }

    // Exact alias match on a normalized signal.
    for (const raw of signals) {
      if (typeof raw !== "string") continue;
      const key = raw.toLowerCase().replace(/[\s-]/g, "_");
      if (PROVIDER_ALIASES[key]) {
        return PROVIDER_ALIASES[key];
      }
    }
    // Substring fallback for names not in the alias table.
    for (const raw of signals) {
      if (typeof raw !== "string") continue;
      const key = raw.toLowerCase();
      if (key.includes("azure") && key.includes("openai")) return "azure_openai";
      if (key.includes("openai")) return "openai";
      if (key.includes("anthropic")) return "anthropic";
      if (key.includes("vertex")) return "vertexai";
      if (
        key.includes("gemini") ||
        key.includes("genai") ||
        key.includes("generativeai") ||
        key.includes("google")
      ) {
        return "gemini";
      }
      if (key.includes("bedrock")) return "aws_bedrock";
    }
    return "";
  } catch (e) {
    return "";
  }
}

function extractInputMessages(args) {
  try {
    const messages = [];
    const input = args && args[0];
    if (!input) {
      return [];
    }

    // Plain string input, e.g. model.invoke("hello").
    if (typeof input === 'string') {
      return [input];
    }
    // StringPromptValue exposes the raw text.
    if (typeof input.text === 'string') {
      return [input.text];
    }
    if (typeof input.value === 'string') {
      return [input.value];
    }

    // Normalize to a message list: ChatPromptValue (piped prompt) uses
    // `.messages`; model.invoke([...]) passes the array directly.
    let messageList;
    if (Array.isArray(input.messages)) {
      messageList = input.messages;
    } else if (typeof input.toChatMessages === 'function') {
      messageList = input.toChatMessages();
    } else if (Array.isArray(input)) {
      messageList = input;
    } else {
      messageList = [];
    }

    for (const msg of messageList) {
      if (msg && msg.content != null && msg.constructor && msg.constructor.name) {
        const content =
          typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content);
        messages.push({ [msg.constructor.name]: content });
      }
    }
    return messages.map(d => JSON.stringify(d));
  } catch (e) {
    console.warn(
      "Warning: Error occurred in extract_input_messages:",
      e
    );
    return [];
  }
}

function extractOutputResponse(response) {
  try {
    const messages = [];
    if (response && response.tool_calls && response.tool_calls.length > 0) {
      messages.push({ [response.constructor.name]: response.tool_calls[0] });
    }
    return messages.map(d => JSON.stringify(d));
  } catch (e) {
    console.warn(
      "Warning: Error occurred in extract_output_response:",
      e
    );
  }
  return [];
}

function extractFinishReason(response) {
  try {
    const meta = response?.response_metadata;
    if (meta) {
      // Key varies by provider: OpenAI finish_reason, Gemini finishReason,
      // Anthropic stop_reason, Bedrock stopReason.
      return (
        meta.finish_reason ||
        meta.finishReason ||
        meta.stop_reason ||
        meta.stopReason ||
        ""
      );
    }
  } catch (e) {
    console.warn(
      "Warning: Error occurred in extract_finish_reason:",
      e
    );
    return "";
  }
  return "";
}

// Classifies a call as a tool-call dispatch vs. a normal end-of-turn response;
// exposed as span.subtype. Checks the AIMessage's `.tool_calls` and finish reason.
function classifyInferenceSubtype(response: any): string {
  try {
    if (response && Array.isArray(response.tool_calls) && response.tool_calls.length > 0) {
      return INFERENCE_TOOL_CALL;
    }
    const finishReason = extractFinishReason(response);
    if (
      finishReason === "tool_calls" ||
      finishReason === "function_call" ||
      finishReason === "tool_use"
    ) {
      return INFERENCE_TOOL_CALL;
    }
  } catch (e) {
    console.warn("Warning: Error occurred in classifyInferenceSubtype:", e);
  }
  return INFERENCE_TURN_END;
}

export const config = {
  "type": SPAN_TYPES.INFERENCE_FRAMEWORK,
  subtype: function ({ response, output }: any) {
    return classifyInferenceSubtype(response ?? output);
  },
  "attributes": [
    [
      {
        "_comment": "provider type ,name , deployment , inference_endpoint",
        "attribute": "type",
        "accessor": function ({ instance }) {
          const provider = detectProvider(instance);
          return provider ? "inference." + provider : "";
        },
      },
      {
        "attribute": "deployment",
        "accessor": function ({ instance }) {
          return (
            instance.engine ||
            instance.deployment ||
            instance.deployment_name ||
            instance.deployment_id ||
            instance.azure_deployment
          );
        },
      },
      {
        "attribute": "inference_endpoint",
        "accessor": function ({ instance }) {
          return (
            instance.azure_endpoint ||
            instance.api_base ||
            instance?.client?.baseURL
          );
        },
      },
      {
        attribute: "provider_name",
        accessor: function ({ instance }) {
          return instance.provider_name || detectProvider(instance) || "unknown_provider";
        },
      },
    ],
    [
      {
        _comment: "LLM Model",
        attribute: "name",
        accessor: function ({ instance }) {
          return instance.model_name || instance.model;
        },
      },
      {
        attribute: "type",
        accessor: function ({ instance }) {
          return "model.llm." + (instance.model_name || instance.model);
        },
      },
    ],
  ],
  events: [
    {
      name: "data.input",
      attributes: [
        {
          _comment: "this is instruction to LLM",
          attribute: "input",
          accessor: function ({
            args,
          }) {
            return extractInputMessages(args);
          },
        },
      ],
    },
    {
      name: "data.output",
      attributes: [
        {
          "_comment": "this is response from LLM",
          "attribute": "response",
          "accessor": function ({ response, exception }) {
            if (exception) {
              return getExceptionMessage({ exception });
            }
            const result = extractAssistantMessage(response)
            if (result.length > 0) {
              return result;
            }
            else {
              return extractOutputResponse(response);
            }
          },
        },
      ],
    },
    {
      name: "metadata",
      attributes: [
        {
          "_comment": "this is response metadata from LLM",
          "accessor": function ({ instance, response }) {
            return getLlmMetadata({ response, instance });
          },
        },
        {
          "_comment": "finish reason from LLM response",
          "attribute": "finish_reason",
          "accessor": function ({ response }) {
            return extractFinishReason(response);
          }
        },
        {
          "_comment": "finish type mapped from finish reason",
          "attribute": "finish_type",
          "accessor": function ({ response }) {
            const finishReason = extractFinishReason(response);
            return mapLangchainFinishReasonToFinishType(finishReason);
          }
        },
      ],
    },
  ],
};
