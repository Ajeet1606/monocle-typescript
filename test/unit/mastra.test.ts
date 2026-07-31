import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { AGENT_REQUEST } from '../../src/instrumentation/metamodel/mastra/entities/agentRequest';
import { SPAN_SUBTYPES } from '../../src/instrumentation/common/constants';
import { MastraTurnSpanHandler } from '../../src/instrumentation/metamodel/mastra/mastraProcessor';
import { MASTRA_TURN_SPAN_ACTIVE_KEY } from '../../src/instrumentation/common/constants';
import { getScopeFromContext } from '../../src/instrumentation/common/utils';
import { config as mastraConfig } from '../../src/instrumentation/metamodel/mastra/methods';
import { INFERENCE, INFERENCE_STREAM } from '../../src/instrumentation/metamodel/mastra/entities/inference';
import { SPAN_TYPES, INFERENCE_TOOL_CALL, INFERENCE_TURN_END } from '../../src/instrumentation/common/constants';

function attrAccessor(schema: any, attribute: string, group = 0): Function {
    const found = schema.attributes[group].find((a: any) => a.attribute === attribute);
    if (!found) throw new Error(`no accessor for attribute "${attribute}"`);
    return found.accessor;
}
function eventAccessor(schema: any, eventName: string, attribute: string): Function {
    const ev = schema.events.find((e: any) => e.name === eventName);
    if (!ev) throw new Error(`no event "${eventName}"`);
    const found = ev.attributes.find((a: any) => a.attribute === attribute);
    if (!found) throw new Error(`no event attribute "${attribute}" on "${eventName}"`);
    return found.accessor;
}

describe('Mastra AGENT_REQUEST schema', () => {
    it('declares the agentic.turn type and turn subtype', () => {
        expect(AGENT_REQUEST.type).toBe('agentic.turn');
        expect(AGENT_REQUEST.subtype).toBe(SPAN_SUBTYPES.TURN);
    });

    it('type accessor returns the Mastra agent type', () => {
        expect(attrAccessor(AGENT_REQUEST, 'type')({})).toBe('agent.mastra');
    });

    describe('name accessor', () => {
        const name = (instance: any) => attrAccessor(AGENT_REQUEST, 'name')({ instance });
        it('prefers instance.name', () => {
            expect(name({ name: 'Weather Agent' })).toBe('Weather Agent');
        });
        it('falls back to instance.id then constructor name', () => {
            expect(name({ id: 'weather-agent' })).toBe('weather-agent');
            class Agent {}
            expect(name(new Agent())).toBe('Agent');
        });
        it('returns "" with no instance', () => {
            expect(name(null)).toBe('');
        });
    });

    describe('data.input accessor', () => {
        const input = (args: any[]) => eventAccessor(AGENT_REQUEST, 'data.input', 'input')({ args });
        it('handles a plain string message', () => {
            expect(input(['what is the weather?'])).toEqual([JSON.stringify({ user: 'what is the weather?' })]);
        });
        it('handles an array of role/content messages', () => {
            expect(input([[{ role: 'user', content: 'hi there' }]]))
                .toEqual([JSON.stringify({ user: 'hi there' })]);
        });
        it('handles content given as an array of text parts', () => {
            expect(input([[{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]]))
                .toEqual([JSON.stringify({ user: 'a b' })]);
        });
        it('handles AI SDK UI messages with a parts array (useChat / playground)', () => {
            expect(input([[{ role: 'user', parts: [{ type: 'text', text: 'weather in Paris?' }] }]]))
                .toEqual([JSON.stringify({ user: 'weather in Paris?' })]);
        });
        it('handles a Mastra message signal (contents + type, single object)', () => {
            // Shape the Studio playground passes: a single signal object, text on
            // `contents`, role on `type`.
            expect(input([{ contents: 'weather in paris', type: 'user', tagName: 'user', __isCreatedSignal: true }]))
                .toEqual([JSON.stringify({ user: 'weather in paris' })]);
        });
        it('returns [] for empty/absent input', () => {
            expect(input([])).toEqual([]);
            expect(input([null])).toEqual([]);
        });
    });

    describe('data.output accessor', () => {
        const output = (bag: any) => eventAccessor(AGENT_REQUEST, 'data.output', 'response')(bag);
        it('returns the final text from a FullOutput-like response', () => {
            expect(output({ response: { text: 'It is sunny.' } })).toBe('It is sunny.');
        });
        it('returns "" when there is no text', () => {
            expect(output({ response: {} })).toBe('');
            expect(output({ response: null })).toBe('');
        });
        it('returns the exception message when the turn errored', () => {
            expect(output({ exception: new Error('boom') })).toContain('boom');
        });
    });
});

describe('MastraTurnSpanHandler', () => {
    const handler = new MastraTurnSpanHandler();

    beforeAll(() => { context.setGlobalContextManager(new AsyncHooksContextManager().enable()); });
    afterAll(() => { context.disable(); });

    it('skipSpan is false at the top level and true once the turn key is set', () => {
        context.with(ROOT_CONTEXT, () => { expect(handler.skipSpan()).toBe(false); });
        context.with(ROOT_CONTEXT.setValue(MASTRA_TURN_SPAN_ACTIVE_KEY, true), () => {
            expect(handler.skipSpan()).toBe(true);
        });
    });

    it('preTracing marks the turn key and generates a turn scope', () => {
        const ctx = handler.preTracing({} as any, ROOT_CONTEXT, {}, ['hi', {}]);
        expect(ctx.getValue(MASTRA_TURN_SPAN_ACTIVE_KEY)).toBe(true);
        expect(getScopeFromContext(ctx, 'agentic.turn')).toBeTruthy();
    });

    it('preTracing reads an app-supplied session id but never fabricates one', () => {
        const withSession = handler.preTracing({} as any, ROOT_CONTEXT, {}, ['hi', { memory: { thread: 'thread-1' } }]);
        expect(getScopeFromContext(withSession, 'agentic.session')).toBe('thread-1');
        const noSession = handler.preTracing({} as any, ROOT_CONTEXT, {}, ['hi', {}]);
        expect(getScopeFromContext(noSession, 'agentic.session')).toBeUndefined();
    });

    it('resolveCompletion returns getFullOutput() for a streaming result, null otherwise', () => {
        const promise = Promise.resolve({ text: 'done' });
        const streamLike = { getFullOutput: () => promise };
        expect(handler.resolveCompletion({ returnValue: streamLike })).toBe(promise);
        expect(handler.resolveCompletion({ returnValue: { text: 'x' } })).toBeNull();
        expect(handler.resolveCompletion({ returnValue: null })).toBeNull();
    });
});

describe('Mastra methods config', () => {
    it('wraps Agent.generate and Agent.stream on @mastra/core/agent as turn spans', () => {
        const byMethod = Object.fromEntries(mastraConfig.map((c: any) => [c.method, c]));
        for (const method of ['generate', 'stream']) {
            const entry = byMethod[method];
            expect(entry).toBeDefined();
            expect(entry.package).toBe('@mastra/core/agent');
            expect(entry.object).toBe('Agent');
            expect(entry.output_processor[0].type).toBe('agentic.turn');
            expect(entry.spanHandler.constructor.name).toBe('MastraTurnSpanHandler');
        }
    });

    it('wraps ModelRouterLanguageModel.doGenerate on @mastra/core/llm as an inference span', () => {
        const entry = (mastraConfig as any[]).find((c) => c.method === 'doGenerate');
        expect(entry).toBeDefined();
        expect(entry.package).toBe('@mastra/core/llm');
        expect(entry.object).toBe('ModelRouterLanguageModel');
        expect(entry.output_processor[0].type).toBe('inference');
        expect(entry.spanHandler.constructor.name).toBe('DefaultSpanHandler');
    });
});

// =============================================================================
// INFERENCE schema — inference (mastra.model.generate)
// =============================================================================
describe('Mastra INFERENCE schema', () => {
    it('declares the inference type', () => {
        expect(INFERENCE.type).toBe(SPAN_TYPES.INFERENCE);
    });

    describe('subtype (from finishReason)', () => {
        const subtype = (response: any) => (INFERENCE.subtype as Function)({ response });
        it('classifies a tool-calls finish as a tool_call inference', () => {
            expect(subtype({ finishReason: 'tool-calls' })).toBe(INFERENCE_TOOL_CALL);
        });
        it('classifies stop / length / missing as turn_end', () => {
            expect(subtype({ finishReason: 'stop' })).toBe(INFERENCE_TURN_END);
            expect(subtype({ finishReason: 'length' })).toBe(INFERENCE_TURN_END);
            expect(subtype(undefined)).toBe(INFERENCE_TURN_END);
        });
        it('handles the Mastra nested finishReason shape ({ unified })', () => {
            expect(subtype({ finishReason: { unified: 'tool-calls' } })).toBe(INFERENCE_TOOL_CALL);
            expect(subtype({ finishReason: { unified: 'stop' } })).toBe(INFERENCE_TURN_END);
        });
    });

    describe('provider type + endpoint (entity 1)', () => {
        const provType = (provider: string) => attrAccessor(INFERENCE, 'type', 0)({ instance: { provider } });
        it('maps router provider ids to inference.<provider>', () => {
            expect(provType('openai')).toBe('inference.openai');
            expect(provType('anthropic')).toBe('inference.anthropic');
            expect(provType('google')).toBe('inference.gemini');
            expect(provType('amazon-bedrock')).toBe('inference.aws_bedrock');
        });
        it('falls back to inference.generic when provider is absent', () => {
            expect(provType('')).toBe('inference.generic');
        });
        it('extracts a best-effort inference endpoint, undefined when unavailable', () => {
            const endpoint = (instance: any) => attrAccessor(INFERENCE, 'inference_endpoint', 0)({ instance });
            expect(endpoint({ config: { baseURL: 'https://api.openai.com/v1' } })).toBe('https://api.openai.com/v1');
            expect(endpoint({ gatewayId: 'models.dev' })).toBe('models.dev');
            expect(endpoint({})).toBeUndefined();
        });
    });

    describe('model attributes (entity 2, off the wrapper instance)', () => {
        it('type is model.llm.<modelId> and name is modelId', () => {
            expect(attrAccessor(INFERENCE, 'type', 1)({ instance: { modelId: 'gpt-5-mini' } })).toBe('model.llm.gpt-5-mini');
            expect(attrAccessor(INFERENCE, 'name', 1)({ instance: { modelId: 'gpt-5-mini' } })).toBe('gpt-5-mini');
        });
    });

    describe('tools declared (entity 3)', () => {
        const toolNames = (args: any[]) => attrAccessor(INFERENCE, 'name', 2)({ args });
        const toolType = (args: any[]) => attrAccessor(INFERENCE, 'type', 2)({ args });
        it('lists declared function-tool names and marks the tool type', () => {
            const args = [{ tools: [{ type: 'function', name: 'get_weather' }, { type: 'function', name: 'get_time' }] }];
            expect(toolNames(args)).toBe('get_weather, get_time');
            expect(toolType(args)).toBe('tool.function');
        });
        it('omits the tools entity when no tools are declared', () => {
            expect(toolNames([{}])).toBeUndefined();
            expect(toolType([{}])).toBeUndefined();
        });
    });

    describe('data.input (LanguageModelV2 prompt)', () => {
        const input = (args: any[]) => eventAccessor(INFERENCE, 'data.input', 'input')({ args });
        it('extracts system string content and user text parts', () => {
            const prompt = [
                { role: 'system', content: 'You are helpful.' },
                { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            ];
            expect(input([{ prompt }])).toEqual([
                JSON.stringify({ system: 'You are helpful.' }),
                JSON.stringify({ user: 'hi' }),
            ]);
        });
        it('serializes assistant tool-call and tool-result parts (tool-using turns)', () => {
            const prompt = [
                { role: 'assistant', content: [{ type: 'tool-call', toolName: 'get_weather', input: '{"city":"NYC"}' }] },
                { role: 'tool', content: [{ type: 'tool-result', toolName: 'get_weather', output: 'sunny' }] },
            ];
            expect(input([{ prompt }])).toEqual([
                JSON.stringify({ assistant: JSON.stringify({ tool_call: { name: 'get_weather', arguments: '{"city":"NYC"}' } }) }),
                JSON.stringify({ tool: JSON.stringify({ tool_result: { name: 'get_weather', output: 'sunny' } }) }),
            ]);
        });
        it('returns [] when there is no prompt', () => {
            expect(input([{}])).toEqual([]);
            expect(input([])).toEqual([]);
        });
    });

    describe('data.output (result.content)', () => {
        const output = (bag: any) => eventAccessor(INFERENCE, 'data.output', 'response')(bag);
        it('joins text parts from content', () => {
            expect(output({ response: { content: [{ type: 'text', text: 'It is sunny.' }] } })).toBe('It is sunny.');
        });
        it('falls back to a serialized tool call when there is no text', () => {
            expect(output({ response: { content: [{ type: 'tool-call', toolName: 'get_weather', input: '{"city":"NYC"}' }] } }))
                .toBe(JSON.stringify({ name: 'get_weather', arguments: '{"city":"NYC"}' }));
        });
        it('returns the exception message on error', () => {
            expect(output({ exception: new Error('boom') })).toContain('boom');
        });
    });

    describe('metadata (tokens + finish reason)', () => {
        const metaEvent = () => (INFERENCE.events as any[]).find((e) => e.name === 'metadata');
        // The token bundle is the metadata attribute with no `attribute` key
        // (its returned dict is spread onto the event).
        const tokens = (response: any) => metaEvent().attributes.find((a: any) => !a.attribute).accessor({ response });
        const meta = (attr: string, response: any) => eventAccessor(INFERENCE, 'metadata', attr)({ response });

        it('extracts flat AI-SDK token numbers', () => {
            const usage = { inputTokens: 11, outputTokens: 22, totalTokens: 33 };
            expect(tokens({ usage })).toEqual({ prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 });
        });
        it('extracts Mastra nested token objects and computes total', () => {
            const usage = {
                inputTokens: { total: 125, cacheRead: 4 },
                outputTokens: { total: 512, text: 128, reasoning: 384 },
            };
            expect(tokens({ usage })).toEqual({
                prompt_tokens: 125, completion_tokens: 512, total_tokens: 637,
                reasoning_tokens: 384, cached_tokens: 4,
            });
        });
        it('omits reasoning/cached when zero or absent', () => {
            const usage = { inputTokens: { total: 5, cacheRead: 0 }, outputTokens: { total: 6 } };
            expect(tokens({ usage })).toEqual({ prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 });
        });
        it('returns undefined when there is no usage', () => {
            expect(tokens({})).toBeUndefined();
        });
        it('reports finish_reason and finish_type from a string or nested { unified }', () => {
            expect(meta('finish_reason', { finishReason: 'tool-calls' })).toBe('tool-calls');
            expect(meta('finish_reason', { finishReason: { unified: 'stop' } })).toBe('stop');
            expect(meta('finish_type', { finishReason: { unified: 'tool-calls' } })).toBe('tool_call');
            expect(meta('finish_type', { finishReason: 'stop' })).toBe('stop');
            expect(meta('finish_type', {})).toBe('unknown');
        });
    });
});

// =============================================================================
// INFERENCE_STREAM — streaming inference (mastra.model.stream)
// =============================================================================
describe('Mastra INFERENCE_STREAM (streaming)', () => {
    function readableFrom(parts: any[]): ReadableStream {
        return new ReadableStream({
            start(c) { for (const p of parts) c.enqueue(p); c.close(); },
        });
    }
    async function drain(stream: ReadableStream): Promise<any[]> {
        const out: any[] = [];
        const reader = stream.getReader();
        while (true) { const { done, value } = await reader.read(); if (done) break; out.push(value); }
        return out;
    }

    it('reuses the INFERENCE schema shape and adds a response_processor', () => {
        expect(INFERENCE_STREAM.type).toBe(SPAN_TYPES.INFERENCE);
        expect(INFERENCE_STREAM.attributes).toBe(INFERENCE.attributes);
        expect(INFERENCE_STREAM.events).toBe(INFERENCE.events);
        expect(typeof (INFERENCE_STREAM as any).response_processor).toBe('function');
    });

    it('observes text-delta + finish parts non-destructively and finalizes on close', async () => {
        const parts = [
            { type: 'stream-start' },
            { type: 'text-start', id: 'm1' },
            { type: 'text-delta', id: 'm1', delta: 'Hello' },
            { type: 'text-delta', id: 'm1', delta: ' world' },
            { type: 'text-end', id: 'm1' },
            { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: { total: 3 }, outputTokens: { total: 5 } } },
        ];
        const returnValue: any = { stream: readableFrom(parts) };
        let finalReturnValue: any;
        (INFERENCE_STREAM as any).response_processor({
            returnValue,
            spanProcessor: ({ finalReturnValue: f }: any) => { finalReturnValue = f; },
        });

        // The app consumes the (now wrapped) stream — parts pass through unchanged.
        const seen = await drain(returnValue.stream);
        expect(seen.map((p: any) => p.type)).toEqual(parts.map((p) => p.type));
        expect(seen[2].delta).toBe('Hello');

        // finalize ran on close with a synthesized doGenerate-shaped result.
        expect(finalReturnValue.content).toEqual([{ type: 'text', text: 'Hello world' }]);
        expect(finalReturnValue.finishReason).toEqual({ unified: 'stop' });

        // The reused INFERENCE accessors read the synthesized result correctly.
        expect(eventAccessor(INFERENCE_STREAM, 'data.output', 'response')({ response: finalReturnValue })).toBe('Hello world');
        const tokenAcc = (INFERENCE_STREAM.events as any[]).find((e) => e.name === 'metadata').attributes.find((a: any) => !a.attribute).accessor;
        expect(tokenAcc({ response: finalReturnValue })).toEqual({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
        expect((INFERENCE_STREAM.subtype as Function)({ response: finalReturnValue })).toBe(INFERENCE_TURN_END);
    });

    it('accumulates a streamed tool-call into the output', async () => {
        const parts = [
            { type: 'tool-call', toolName: 'get_weather', input: '{"city":"NYC"}' },
            { type: 'finish', finishReason: { unified: 'tool-calls' }, usage: { inputTokens: { total: 2 }, outputTokens: { total: 1 } } },
        ];
        const returnValue: any = { stream: readableFrom(parts) };
        let finalReturnValue: any;
        (INFERENCE_STREAM as any).response_processor({
            returnValue,
            spanProcessor: ({ finalReturnValue: f }: any) => { finalReturnValue = f; },
        });
        await drain(returnValue.stream);
        expect(eventAccessor(INFERENCE_STREAM, 'data.output', 'response')({ response: finalReturnValue }))
            .toContain('get_weather');
        expect((INFERENCE_STREAM.subtype as Function)({ response: finalReturnValue })).toBe(INFERENCE_TOOL_CALL);
    });

    it('finalizes immediately for a non-stream return value', () => {
        let finalReturnValue: any;
        (INFERENCE_STREAM as any).response_processor({
            returnValue: { content: [{ type: 'text', text: 'x' }] },
            spanProcessor: ({ finalReturnValue: f }: any) => { finalReturnValue = f; },
        });
        expect(finalReturnValue).toEqual({ content: [{ type: 'text', text: 'x' }] });
    });
});
