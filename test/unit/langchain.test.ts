import { describe, it, expect } from 'vitest';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { config as langchainInferenceConfig } from '../../src/instrumentation/metamodel/langchain/entities/inference';
import { SPAN_TYPES } from '../../src/instrumentation/common/constants';

// =============================================================================
// Helpers for reaching into the declarative schema
// =============================================================================
// The instrumentation is a data structure of accessor functions. Each test
// pulls the relevant accessor out of the schema and drives it directly with a
// synthetic { instance, args, response, exception } context — the same shape
// the span handler passes at runtime.
const providerAttrs = langchainInferenceConfig.attributes[0] as any[];
const modelAttrs = langchainInferenceConfig.attributes[1] as any[];

const getAccessor = (group: any[], attribute: string) =>
    group.find((a) => a.attribute === attribute)!.accessor;

const getEvent = (name: string) =>
    langchainInferenceConfig.events.find((e: any) => e.name === name)!;

const getEventAccessor = (eventName: string, attribute: string) => {
    const attr = getEvent(eventName).attributes.find((a: any) => a.attribute === attribute);
    return attr!.accessor as (ctx: any) => any;
};

// Minimal stand-ins whose constructor.name drives the schema branching.
// Real langchain chat models also expose `_llmType()` and `lc_namespace`, which
// the generalized provider detection prefers over the class name — the fakes
// below mirror whichever signal the corresponding test is exercising.
class ChatOpenAI {
    constructor(fields: any = {}) {
        Object.assign(this, fields);
    }
}
class AzureChatOpenAI {
    constructor(fields: any = {}) {
        Object.assign(this, fields);
    }
}
class AIMessage {
    constructor(fields: any = {}) {
        Object.assign(this, fields);
    }
}
// Build a fake chat model with a specific constructor name plus whichever of
// the real langchain identity signals (`_llmType()`, `lc_namespace`) a test
// wants to exercise. `constructor.name` comes from the computed-key class.
const makeChatModel = (
    className: string,
    { llmType, namespace }: { llmType?: string; namespace?: string[] } = {}
) => {
    const cls = { [className]: class {} }[className];
    const instance: any = new cls();
    if (llmType !== undefined) instance._llmType = () => llmType;
    if (namespace !== undefined) instance.lc_namespace = namespace;
    return instance;
};

// =============================================================================
// Schema shape
// =============================================================================
describe('LangChain inference schema shape', () => {
    it('is an inference.framework span with input, output and metadata events', () => {
        expect(langchainInferenceConfig.type).toBe(SPAN_TYPES.INFERENCE_FRAMEWORK);
        const eventNames = langchainInferenceConfig.events.map((e: any) => e.name);
        expect(eventNames).toEqual(['data.input', 'data.output', 'metadata']);
    });
});

// =============================================================================
// entity.1 — provider attributes (type, deployment, inference_endpoint, provider_name)
// =============================================================================
describe('LangChain inference provider (entity.1) attributes', () => {
    const type = getAccessor(providerAttrs, 'type');
    const deployment = getAccessor(providerAttrs, 'deployment');
    const endpoint = getAccessor(providerAttrs, 'inference_endpoint');
    const providerName = getAccessor(providerAttrs, 'provider_name');

    it('classifies ChatOpenAI as inference.openai (via constructor name)', () => {
        expect(type({ instance: new ChatOpenAI() })).toBe('inference.openai');
    });

    it('classifies AzureChatOpenAI as inference.azure_openai (via constructor name)', () => {
        expect(type({ instance: new AzureChatOpenAI() })).toBe('inference.azure_openai');
    });

    // Generalized, provider-agnostic detection: langchain wires up many chat
    // models (Gemini, Anthropic, VertexAI, Bedrock, …) that are NOT OpenAI.
    // Detection must not be hardcoded to OpenAI — it should read the langchain
    // identity signals (_llmType() / lc_namespace) that every chat model exposes.
    it('classifies ChatGoogleGenerativeAI as inference.gemini (via _llmType)', () => {
        const gemini = makeChatModel('ChatGoogleGenerativeAI', {
            llmType: 'googlegenerativeai',
            namespace: ['langchain', 'chat_models', 'google_genai'],
        });
        expect(type({ instance: gemini })).toBe('inference.gemini');
    });

    it('classifies ChatGoogleGenerativeAI via lc_namespace when _llmType is absent', () => {
        const gemini = makeChatModel('ChatGoogleGenerativeAI', {
            namespace: ['langchain', 'chat_models', 'google_genai'],
        });
        expect(type({ instance: gemini })).toBe('inference.gemini');
    });

    it('classifies ChatAnthropic as inference.anthropic', () => {
        const anthropic = makeChatModel('ChatAnthropic', { llmType: 'anthropic' });
        expect(type({ instance: anthropic })).toBe('inference.anthropic');
    });

    it('classifies ChatVertexAI as inference.vertexai', () => {
        const vertex = makeChatModel('ChatVertexAI', {
            namespace: ['langchain', 'chat_models', 'google_vertexai'],
        });
        expect(type({ instance: vertex })).toBe('inference.vertexai');
    });

    it('classifies Bedrock chat models as inference.aws_bedrock', () => {
        const bedrock = makeChatModel('ChatBedrockConverse', { llmType: 'bedrock' });
        expect(type({ instance: bedrock })).toBe('inference.aws_bedrock');
    });

    it('distinguishes AzureChatOpenAI from ChatOpenAI via _llmType', () => {
        // _llmType() reliably reports "azure_openai" vs "openai" even though the
        // Azure class extends ChatOpenAI.
        const azure = makeChatModel('AzureChatOpenAI', { llmType: 'azure_openai' });
        const openai = makeChatModel('ChatOpenAI', { llmType: 'openai' });
        expect(type({ instance: azure })).toBe('inference.azure_openai');
        expect(type({ instance: openai })).toBe('inference.openai');
    });

    it('returns "" for an unknown provider', () => {
        class SomethingElse {}
        expect(type({ instance: new SomethingElse() })).toBe('');
    });

    it('reads deployment from the first available deployment-ish field', () => {
        expect(deployment({ instance: { azure_deployment: 'gpt-4o-dep' } })).toBe('gpt-4o-dep');
        expect(deployment({ instance: { engine: 'my-engine' } })).toBe('my-engine');
    });

    it('reads inference_endpoint, preferring azure_endpoint then client.baseURL', () => {
        expect(endpoint({ instance: { azure_endpoint: 'https://azure.example' } })).toBe(
            'https://azure.example'
        );
        expect(endpoint({ instance: { client: { baseURL: 'https://api.openai.com/v1' } } })).toBe(
            'https://api.openai.com/v1'
        );
    });

    it('prefers an explicit provider_name field', () => {
        expect(providerName({ instance: { provider_name: 'openai' } })).toBe('openai');
    });

    it('derives provider_name from the detected provider when not set explicitly', () => {
        const gemini = makeChatModel('ChatGoogleGenerativeAI', { llmType: 'googlegenerativeai' });
        expect(providerName({ instance: gemini })).toBe('gemini');
    });

    it('falls back to unknown_provider when the provider cannot be determined', () => {
        expect(providerName({ instance: {} })).toBe('unknown_provider');
    });
});

// =============================================================================
// entity.2 — model attributes (name, type)
// =============================================================================
describe('LangChain inference model (entity.2) attributes', () => {
    const name = getAccessor(modelAttrs, 'name');
    const type = getAccessor(modelAttrs, 'type');

    it('reads the model name from model_name or model', () => {
        expect(name({ instance: { model_name: 'gpt-4o-mini' } })).toBe('gpt-4o-mini');
        expect(name({ instance: { model: 'gpt-3.5-turbo' } })).toBe('gpt-3.5-turbo');
    });

    it('builds the model type as model.llm.<name>', () => {
        expect(type({ instance: { model_name: 'gpt-4o-mini' } })).toBe('model.llm.gpt-4o-mini');
        expect(type({ instance: { model: 'gpt-3.5-turbo' } })).toBe('model.llm.gpt-3.5-turbo');
    });
});

// =============================================================================
// data.input event — input extraction
// =============================================================================
// The wrapped method is BaseChatModel.invoke(input, options), so the accessor
// receives the invoke arguments as `args`. `args[0]` (the input) can take
// several shapes depending on how the model is called:
//   - a plain string:               model.invoke("hello")
//   - a StringPromptValue:          PromptTemplate.pipe(model)
//   - a ChatPromptValue:            ChatPromptTemplate.pipe(model)   <-- regressed
//   - a raw array of messages:      model.invoke([msg1, msg2])
// The bug: piping a ChatPromptTemplate into the model yields a ChatPromptValue,
// which is neither iterable nor has a `.text`, so extraction returned [].
describe('LangChain inference data.input extraction', () => {
    const extract = (args: any) => getEventAccessor('data.input', 'input')({ args });

    it('extracts messages from a ChatPromptValue (ChatPromptTemplate piped into the model)', async () => {
        // This is the exact shape that regressed: a chat prompt template piped
        // into the model hands invoke() a ChatPromptValue with a `.messages`
        // array — not an iterable and with no `.text` property.
        const prompt = ChatPromptTemplate.fromMessages([
            ['system', 'You are a concise assistant.'],
            ['human', '{question}'],
        ]);
        const promptValue = await prompt.invoke({ question: 'What is observability?' });

        expect(extract([promptValue])).toEqual([
            JSON.stringify({ SystemMessage: 'You are a concise assistant.' }),
            JSON.stringify({ HumanMessage: 'What is observability?' }),
        ]);
    });

    it('extracts messages from a raw array of messages', () => {
        const args = [[new SystemMessage('system prompt'), new HumanMessage('user question')]];
        expect(extract(args)).toEqual([
            JSON.stringify({ SystemMessage: 'system prompt' }),
            JSON.stringify({ HumanMessage: 'user question' }),
        ]);
    });

    it('extracts a plain string input', () => {
        expect(extract(['just a plain string'])).toEqual(['just a plain string']);
    });

    it('extracts a StringPromptValue via its .value', () => {
        // StringPromptValue exposes the rendered prompt as `.value`.
        expect(extract([{ value: 'rendered prompt text' }])).toEqual(['rendered prompt text']);
    });

    it('extracts a prompt value that only exposes .text', () => {
        expect(extract([{ text: 'text field prompt' }])).toEqual(['text field prompt']);
    });

    it('stringifies non-string (multimodal) message content', () => {
        const multimodal = [
            { text: 'describe this image' },
            { type: 'image_url', image_url: { url: 'http://example.com/x.png' } },
        ];
        const args = [[new HumanMessage({ content: multimodal as any })]];
        expect(extract(args)).toEqual([
            JSON.stringify({ HumanMessage: JSON.stringify(multimodal) }),
        ]);
    });

    it('returns an empty array when there is no input', () => {
        expect(extract([])).toEqual([]);
        expect(extract([null])).toEqual([]);
        expect(extract([undefined])).toEqual([]);
    });
});

// =============================================================================
// data.output event — response only (status / status_code removed)
// =============================================================================
describe('LangChain inference data.output extraction', () => {
    const response = getEventAccessor('data.output', 'response');

    it('emits only the response (no status / status_code)', () => {
        const attrs = getEvent('data.output').attributes.map((a: any) => a.attribute).filter(Boolean);
        expect(attrs).toContain('response');
        expect(attrs).not.toContain('status');
        expect(attrs).not.toContain('status_code');
    });

    it('returns the assistant message content on success', () => {
        expect(response({ response: { content: 'the answer' } })).toBe('the answer');
    });

    it('returns the exception message when the call failed', () => {
        expect(
            response({ exception: { message: 'Incorrect API key provided' } })
        ).toBe('Incorrect API key provided');
    });

    it('falls back to tool_calls when there is no text content', () => {
        // An AIMessage that only carries a tool call (empty content) should
        // surface the tool call rather than an empty response.
        const toolCall = { name: 'get_weather', args: { city: 'SF' } };
        const aiMessage = new AIMessage({ content: '', tool_calls: [toolCall] });
        expect(response({ response: aiMessage })).toEqual([
            JSON.stringify({ AIMessage: toolCall }),
        ]);
    });
});

// =============================================================================
// span.subtype — dynamic top-level subtype classifier
// =============================================================================
describe('LangChain inference span.subtype classifier', () => {
    const subtype = (response: any) => (langchainInferenceConfig as any).subtype({ response });

    it('is exposed as a function on the schema', () => {
        expect(typeof (langchainInferenceConfig as any).subtype).toBe('function');
    });

    it('classifies a normal completion as turn_end', () => {
        const response = { content: 'the answer', response_metadata: { finish_reason: 'stop' } };
        expect(subtype(response)).toBe('turn_end');
    });

    it('classifies a response carrying tool_calls as tool_call', () => {
        const response = { content: '', tool_calls: [{ name: 'get_weather', args: {} }] };
        expect(subtype(response)).toBe('tool_call');
    });

    it('classifies a tool_calls / tool_use finish_reason as tool_call', () => {
        expect(subtype({ response_metadata: { finish_reason: 'tool_calls' } })).toBe('tool_call');
        expect(subtype({ response_metadata: { stopReason: 'tool_use' } })).toBe('tool_call');
    });

    it('falls back to turn_end for an empty or malformed response', () => {
        expect(subtype(undefined)).toBe('turn_end');
        expect(subtype({})).toBe('turn_end');
    });

    it('reads the response from `output` when `response` is absent', () => {
        const output = { tool_calls: [{ name: 'x', args: {} }] };
        expect((langchainInferenceConfig as any).subtype({ output })).toBe('tool_call');
    });
});

// =============================================================================
// metadata event — token usage, finish_reason, finish_type
// =============================================================================
describe('LangChain inference metadata extraction', () => {
    // The token-usage accessor is the one metadata attribute with no `attribute`
    // key (it spreads a whole dict), so grab it by position.
    const usageAccessor = getEvent('metadata').attributes[0].accessor as (ctx: any) => any;
    const finishReason = getEventAccessor('metadata', 'finish_reason');
    const finishType = getEventAccessor('metadata', 'finish_type');

    it('extracts token usage from response_metadata.tokenUsage', () => {
        const response = {
            response_metadata: {
                tokenUsage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
            },
        };
        expect(usageAccessor({ response, instance: {} })).toMatchObject({
            prompt_tokens: 12,
            completion_tokens: 8,
            total_tokens: 20,
        });
    });

    it('extracts token usage from a top-level usage object', () => {
        const response = { usage: { input_tokens: 5, output_tokens: 7 } };
        expect(usageAccessor({ response, instance: {} })).toMatchObject({
            input_tokens: 5,
            output_tokens: 7,
            total_tokens: 12,
        });
    });

    it('reads finish_reason from response_metadata (OpenAI snake_case)', () => {
        const response = { response_metadata: { finish_reason: 'stop' } };
        expect(finishReason({ response })).toBe('stop');
    });

    it('reads finishReason from response_metadata (Gemini camelCase)', () => {
        // @langchain/google-genai stores it as response_metadata.finishReason
        // (camelCase), e.g. "STOP" — not the snake_case OpenAI uses.
        const response = { response_metadata: { finishReason: 'STOP' } };
        expect(finishReason({ response })).toBe('STOP');
    });

    it('reads stop_reason from response_metadata (Anthropic)', () => {
        const response = { response_metadata: { stop_reason: 'end_turn' } };
        expect(finishReason({ response })).toBe('end_turn');
    });

    it('reads stopReason from response_metadata (Bedrock camelCase)', () => {
        // @langchain/aws (Bedrock Converse) stores it as response_metadata.stopReason.
        const response = { response_metadata: { stopReason: 'end_turn' } };
        expect(finishReason({ response })).toBe('end_turn');
    });

    it('returns "" when finish_reason is absent', () => {
        expect(finishReason({ response: {} })).toBe('');
    });

    it('maps finish_reason to a normalized finish_type', () => {
        expect(finishType({ response: { response_metadata: { finish_reason: 'stop' } } })).toBe(
            'success'
        );
        expect(finishType({ response: { response_metadata: { finish_reason: 'length' } } })).toBe(
            'truncated'
        );
        expect(
            finishType({ response: { response_metadata: { finish_reason: 'content_filter' } } })
        ).toBe('content_filter');
    });

    it('maps a Gemini camelCase finishReason to a finish_type', () => {
        // "STOP" must resolve to success even though it arrives camelCase.
        expect(finishType({ response: { response_metadata: { finishReason: 'STOP' } } })).toBe(
            'success'
        );
    });

    it('maps Bedrock stopReason values to finish_types', () => {
        const ft = (stopReason: string) =>
            finishType({ response: { response_metadata: { stopReason } } });
        expect(ft('end_turn')).toBe('success');
        expect(ft('max_tokens')).toBe('truncated');
        expect(ft('tool_use')).toBe('success');
        expect(ft('content_filtered')).toBe('content_filter');
        expect(ft('guardrail_intervened')).toBe('content_filter');
    });
});
