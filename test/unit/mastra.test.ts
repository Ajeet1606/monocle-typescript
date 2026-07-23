import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { AGENT_REQUEST } from '../../src/instrumentation/metamodel/mastra/entities/agentRequest';
import { SPAN_SUBTYPES } from '../../src/instrumentation/common/constants';
import { MastraTurnSpanHandler } from '../../src/instrumentation/metamodel/mastra/mastraProcessor';
import { MASTRA_TURN_SPAN_ACTIVE_KEY } from '../../src/instrumentation/common/constants';
import { getScopeFromContext } from '../../src/instrumentation/common/utils';
import { config as mastraConfig } from '../../src/instrumentation/metamodel/mastra/methods';

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
});
