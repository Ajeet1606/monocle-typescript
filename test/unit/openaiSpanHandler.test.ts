import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { context, SpanStatusCode } from '@opentelemetry/api';
import { config as openaiMethods } from '../../src/instrumentation/metamodel/openai/methods';

function createMockSpan() {
    const attributes: Record<string, any> = {};
    const events: Array<{ name: string; attributes: Record<string, any> }> = [];
    return {
        attributes,
        events,
        // child span, so processSpan starts entity indexing at 1
        parentSpanContext: { spanId: 'parent-span-id' },
        setAttribute: vi.fn((key: string, value: any) => {
            attributes[key] = value;
        }),
        addEvent: vi.fn((name: string, eventAttributes: Record<string, any>) => {
            events.push({ name, attributes: eventAttributes });
        }),
        setStatus: vi.fn(),
        updateName: vi.fn(),
        spanContext: vi.fn().mockReturnValue({ traceId: 'trace-id' }),
        status: { code: SpanStatusCode.UNSET }
    };
}

function setActiveWorkflowType(workflowType: string | undefined) {
    vi.spyOn(context, 'active').mockReturnValue({
        getValue: vi.fn().mockReturnValue(workflowType)
    } as any);
}

const embeddingsElement: any = openaiMethods.find(
    (element: any) => element.spanName === 'openai_embeddings'
);
const chatElement: any = openaiMethods.find(
    (element: any) => element.spanName === 'openai_chat'
);

const embeddingsInstance = { _client: { baseURL: 'https://api.openai.com/v1' } };
const embeddingsArgs = [
    { model: 'text-embedding-ada-002', input: ['whats coffee'] }
] as unknown as IArguments;
const embeddingsResponse = { data: [{ embedding: [0.1, 0.2, 0.3] }] };

function processEmbeddingsSpan() {
    const span = createMockSpan();
    embeddingsElement.spanHandler.processSpan({
        span,
        instance: embeddingsInstance,
        args: embeddingsArgs,
        returnValue: embeddingsResponse,
        outputProcessor: embeddingsElement.output_processor,
        wrappedPackage: 'openai'
    });
    return span;
}

describe('OpenAISpanHandler', () => {
    beforeEach(() => {
        setActiveWorkflowType(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('embeddings span', () => {
        it('keeps retrieval semantics when a framework workflow (LangChain) is active', () => {
            setActiveWorkflowType('workflow.langchain');

            const span = processEmbeddingsSpan();

            expect(span.attributes['span.type']).toBe('retrieval');
            expect(span.attributes['entity.1.name']).toBe('text-embedding-ada-002');
            expect(span.attributes['entity.1.type']).toBe(
                'model.embedding.text-embedding-ada-002'
            );
            expect(span.attributes['entity.count']).toBe(1);

            const inputEvent = span.events.find((event) => event.name === 'data.input');
            expect(inputEvent?.attributes.input).toEqual(['whats coffee']);

            const outputEvent = span.events.find((event) => event.name === 'data.output');
            expect(outputEvent?.attributes.response).toBe('0.1,0.2,0.3...');
            expect(outputEvent?.attributes.status).toBe('success');
        });

        it('keeps retrieval semantics for a direct OpenAI call', () => {
            const span = processEmbeddingsSpan();

            expect(span.attributes['span.type']).toBe('retrieval');
            expect(span.attributes['entity.1.type']).toBe(
                'model.embedding.text-embedding-ada-002'
            );
        });
    });

    describe('chat span', () => {
        function processChatSpan() {
            const span = createMockSpan();
            chatElement.spanHandler.processSpan({
                span,
                instance: { _client: { baseURL: 'https://api.openai.com/v1' } },
                args: [
                    { model: 'gpt-3.5-turbo', messages: [{ role: 'user', content: 'hi' }] }
                ] as unknown as IArguments,
                returnValue: {
                    choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
                },
                outputProcessor: chatElement.output_processor,
                wrappedPackage: 'openai'
            });
            return span;
        }

        // Guards the deliberate behaviour from #111/#113: the framework's own
        // langchain.chat span carries the prompt/response/tokens, so the
        // model-API span defers instead of duplicating them.
        it('defers to the framework inference span when a framework workflow is active', () => {
            setActiveWorkflowType('workflow.langchain');

            const span = processChatSpan();

            expect(span.attributes['span.type']).toBe('inference.modelapi');
            expect(span.attributes['entity.1.type']).toBeUndefined();
            expect(span.events).toHaveLength(0);
        });

        it('is a full inference span for a direct OpenAI call', () => {
            const span = processChatSpan();

            expect(span.attributes['span.type']).toBe('inference');
            expect(span.attributes['entity.1.type']).toBe('inference.openai');
            expect(span.attributes['entity.2.type']).toBe('model.llm.gpt-3.5-turbo');
            expect(span.attributes['entity.count']).toBe(2);
            expect(span.events.map((event) => event.name)).toEqual([
                'data.input',
                'data.output',
                'metadata'
            ]);
        });
    });
});
