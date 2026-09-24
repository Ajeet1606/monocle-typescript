# HTTP Process Spans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit a properly typed `http.process` span for every request, beneath a `workflow` span, replacing the bare root span the trace-return hook hand-rolls today. (Amended 2026-09-24: originally scoped to trace-return requests only; Tasks 6 and 7 generalise it.)

**Architecture:** One `node:http` server hook creates two spans per request — a `workflow` span as the trace root and an `http.process` span beneath it — and applies a declarative metamodel to the latter at `res.end`. Trace return stops owning a span and instead registers a callback with the hook to append its trailer. Capture is duck-typed: we read `req.route` and `req.body` that Express already populated rather than patching any framework.

**Tech Stack:** TypeScript, OpenTelemetry JS SDK (`@opentelemetry/api`, `@opentelemetry/sdk-trace-node`), Node `node:http` / `node:https`, Vitest, Express (devDependency, test-only).

**Spec:** `docs/superpowers/specs/2026-09-23-http-process-spans-design.md`

## Global Constraints

- `src/instrumentation/http/` must not import from `src/traceReturn/`. The dependency is inverted: trace return registers callbacks with the hook.
- `MAX_DATA_LENGTH = 1000`, `MAX_STREAMING_CAPTURE_LENGTH = 5000`. Exact values, matching `monocle_apptrace`.
- Attribute names are exactly: entity `method`, `route`, `url`; `data.input` `params`, `request_body`; `data.output` `status_code`, `response`. No others.
- `status_code` is a **string** (`"200"`), never a number.
- `params` is the **raw query string** (`"lang=en&verbose=true"`), not parsed, not merged with route params.
- Entity attributes land at `entity.1.*`, which requires `http.process` to have the `workflow` span as its parent.
- Entity accessors receive `{instance, args, output, parentSpan}`; event accessors receive `{args, response, instance, exception}`. The `ServerResponse` is `output` in one and `response` in the other.
- A tracing feature must never take a request down. Every capture path is individually guarded and falls back to an empty value.
- Do not capture request or response headers.
- Comments: at most 4 lines. Refer to `monocle_apptrace` / `monocle_test_tools`, never "Python".
- Commits: `git commit -s -m "..."`. No co-author trailer.

## Review Focus

Five input classes the spec implies but does not call out, most likely to bite first. Each has a test assigned to the task that owns the code.

1. **Binary response bodies** (an image or PDF download) decoded as UTF-8 produce mojibake in the span. Expected: no response body captured for a non-textual `content-type`. → Task 1.
2. **A large response streamed in many chunks** must respect a cumulative cap, not a per-chunk one, or 1000 chunks of 100 chars each store 100 KB. Expected: capture stops at `MAX_STREAMING_CAPTURE_LENGTH` across all chunks. → Task 1.
3. **A circular or non-serializable `req.body`** makes `JSON.stringify` throw inside an accessor. Expected: empty attribute, request unaffected. → Task 1.
4. **A request with no query string** must not emit `params` at all, rather than an empty string. → Task 2.
5. **A request with no `Host` header** (HTTP/1.0, or a raw socket client) must not produce `http://undefined/path`. → Task 1.

---

### Task 1: Capture helpers

Pure functions that read `req` and `res`. No spans, no OpenTelemetry, no server — everything here is testable with plain objects, which is why it comes first.

**Files:**
- Create: `src/instrumentation/http/constants.ts`
- Create: `src/instrumentation/http/capture.ts`
- Test: `test/unit/httpCapture.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MAX_DATA_LENGTH: number`, `MAX_STREAMING_CAPTURE_LENGTH: number`, `HTTP_CAPTURE_KEY: symbol`
  - `interface HttpCapture { body: string; truncated: boolean }`
  - `getMethod(req: any): string`
  - `getRoute(req: any): string`
  - `getUrl(req: any): string`
  - `getParams(req: any): string`
  - `getRequestBody(req: any): string`
  - `getStatusCode(res: any): string`
  - `getResponseBody(res: any): string`
  - `appendResponseChunk(res: any, chunk: unknown): void`
  - `stringifyBody(value: unknown, limit: number): string`

- [ ] **Step 1: Write the failing test**

Create `test/unit/httpCapture.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
    appendResponseChunk, getMethod, getParams, getRequestBody, getResponseBody,
    getRoute, getStatusCode, getUrl, stringifyBody,
} from "../../src/instrumentation/http/capture";
import { MAX_STREAMING_CAPTURE_LENGTH } from "../../src/instrumentation/http/constants";

function fakeRes(headers: Record<string, string> = {}, statusCode = 200): any {
    return { statusCode, getHeader: (n: string) => headers[n.toLowerCase()] };
}

describe("route", () => {
    it("prefers the Express route template over the concrete path", () => {
        expect(getRoute({ url: "/users/12345?x=1", baseUrl: "", route: { path: "/users/:id" } }))
            .toBe("/users/:id");
    });

    it("joins baseUrl for a mounted router, matching monocle_apptrace", () => {
        expect(getRoute({ url: "/api/v1/ask?lang=en", baseUrl: "/api", route: { path: "/v1/ask" } }))
            .toBe("/api/v1/ask");
    });

    it("falls back to the path with the query stripped when no framework matched", () => {
        expect(getRoute({ url: "/users/12345?x=1" })).toBe("/users/12345");
    });
});

describe("url", () => {
    it("builds scheme, host and target including the query", () => {
        expect(getUrl({ url: "/api/v1/ask?lang=en", headers: { host: "127.0.0.1:8123" }, socket: {} }))
            .toBe("http://127.0.0.1:8123/api/v1/ask?lang=en");
    });

    it("uses https for a TLS socket", () => {
        expect(getUrl({ url: "/x", headers: { host: "h" }, socket: { encrypted: true } }))
            .toBe("https://h/x");
    });

    it("prefers x-forwarded-proto behind a proxy", () => {
        expect(getUrl({ url: "/x", headers: { host: "h", "x-forwarded-proto": "https,http" }, socket: {} }))
            .toBe("https://h/x");
    });

    // Review Focus 5: a client that sends no Host header must not yield "http://undefined/x".
    it("falls back to localhost when there is no Host header", () => {
        expect(getUrl({ url: "/x", headers: {}, socket: {} })).toBe("http://localhost/x");
    });
});

describe("params", () => {
    it("returns the raw query string, unparsed", () => {
        expect(getParams({ url: "/ask?lang=en&verbose=true" })).toBe("lang=en&verbose=true");
    });

    // Review Focus 4: absent query must be falsy so processSpan omits the attribute.
    it("returns empty string when there is no query", () => {
        expect(getParams({ url: "/ask" })).toBe("");
    });
});

describe("request body", () => {
    it("serialises a parsed object body", () => {
        expect(getRequestBody({ body: { question: "What is Task Decomposition?" } }))
            .toBe('{"question":"What is Task Decomposition?"}');
    });

    it("passes a string body through", () => {
        expect(getRequestBody({ body: "raw text" })).toBe("raw text");
    });

    it("decodes a Buffer body", () => {
        expect(getRequestBody({ body: Buffer.from('{"a":1}') })).toBe('{"a":1}');
    });

    it("returns empty string when no body parser ran", () => {
        expect(getRequestBody({})).toBe("");
    });

    // Review Focus 3: a circular body must not throw out of the accessor.
    it("returns empty string for a circular body instead of throwing", () => {
        const body: any = { a: 1 };
        body.self = body;
        expect(getRequestBody({ body })).toBe("");
    });

    it("truncates to the limit", () => {
        expect(stringifyBody("x".repeat(5000), 1000)).toHaveLength(1000);
    });
});

describe("status code", () => {
    it("is a string, matching monocle_apptrace", () => {
        expect(getStatusCode(fakeRes({}, 200))).toBe("200");
    });

    it("is empty when the status is not set", () => {
        expect(getStatusCode({})).toBe("");
    });
});

describe("response body capture", () => {
    it("accumulates chunks in order", () => {
        const res = fakeRes({ "content-type": "application/json" });
        appendResponseChunk(res, '{"answer":');
        appendResponseChunk(res, '"42"}');
        expect(getResponseBody(res)).toBe('{"answer":"42"}');
    });

    it("captures when no content-type has been set yet", () => {
        const res = fakeRes();
        appendResponseChunk(res, "hello");
        expect(getResponseBody(res)).toBe("hello");
    });

    // Review Focus 1: a binary download must not be decoded into the span.
    it("captures nothing for a binary content-type", () => {
        const res = fakeRes({ "content-type": "image/png" });
        appendResponseChunk(res, Buffer.from([0xff, 0xd8, 0xff]));
        expect(getResponseBody(res)).toBe("");
    });

    // Review Focus 2: the cap is cumulative across chunks, not per chunk.
    it("stops at the streaming cap across many chunks", () => {
        const res = fakeRes({ "content-type": "text/event-stream" });
        for (let i = 0; i < 1000; i++) appendResponseChunk(res, "x".repeat(100));
        expect(getResponseBody(res)).toHaveLength(MAX_STREAMING_CAPTURE_LENGTH);
    });

    it("returns empty string when nothing was written", () => {
        expect(getResponseBody(fakeRes())).toBe("");
    });
});

describe("method", () => {
    it("reads req.method", () => {
        expect(getMethod({ method: "POST" })).toBe("POST");
    });

    it("is empty when absent", () => {
        expect(getMethod({})).toBe("");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/httpCapture.test.ts`
Expected: FAIL — cannot resolve `src/instrumentation/http/capture`.

- [ ] **Step 3: Write the constants**

Create `src/instrumentation/http/constants.ts`:

```ts
// Caps match monocle_apptrace's MAX_DATA_LENGTH and MAX_STREAMING_CAPTURE_LENGTH
// so a TypeScript span truncates where an upstream one would.
export const MAX_DATA_LENGTH = 1000;
export const MAX_STREAMING_CAPTURE_LENGTH = 5000;

// The accumulated response body lives on the ServerResponse: the metamodel
// accessors are pure reads, so whatever they need must already be there.
export const HTTP_CAPTURE_KEY = Symbol("monocle.httpCapture");

export interface HttpCapture {
    body: string;
    truncated: boolean;
}
```

- [ ] **Step 4: Write the capture helpers**

Create `src/instrumentation/http/capture.ts`:

```ts
import { HTTP_CAPTURE_KEY, HttpCapture, MAX_DATA_LENGTH, MAX_STREAMING_CAPTURE_LENGTH } from "./constants";

// Content types whose bytes are text. An unset content-type counts as textual:
// a handler that writes before setting one is almost always writing JSON.
const TEXTUAL_CONTENT_TYPE =
    /^(?:text\/|application\/(?:json|xml|javascript|x-www-form-urlencoded|[a-z0-9.+-]*\+json))/;

function headerValue(req: any, name: string): string | undefined {
    const value = req?.headers?.[name];
    return Array.isArray(value) ? value[0] : value;
}

function stripQuery(url: string): string {
    const q = url.indexOf("?");
    return q === -1 ? url : url.slice(0, q);
}

// Byte-truncates before decoding so a large Buffer is never materialised as a
// string. Four bytes per character is the UTF-8 worst case.
function decodeCapped(buf: Buffer, limit: number): string {
    return buf.subarray(0, limit * 4).toString("utf8");
}

export function stringifyBody(value: unknown, limit: number): string {
    if (value === undefined || value === null) return "";
    let text: string;
    if (typeof value === "string") text = value;
    else if (Buffer.isBuffer(value)) text = decodeCapped(value, limit);
    else {
        try {
            text = JSON.stringify(value) ?? "";
        } catch {
            return ""; // circular or non-serialisable: an empty attribute beats a throw
        }
    }
    return text.length > limit ? text.slice(0, limit) : text;
}

export function getMethod(req: any): string {
    return typeof req?.method === "string" ? req.method : "";
}

// req.route is set by Express when a route matches, and baseUrl by a mounted
// router. Reading them is duck typing, not a dependency: absent, we degrade to
// the concrete path rather than failing.
export function getRoute(req: any): string {
    const routePath = req?.route?.path;
    if (typeof routePath === "string" && routePath.length > 0) {
        const base = typeof req?.baseUrl === "string" ? req.baseUrl : "";
        const joined = `${base}${routePath}`;
        return joined.length > 1 && joined.endsWith("/") ? joined.slice(0, -1) : joined;
    }
    return stripQuery(typeof req?.url === "string" ? req.url : "");
}

export function getUrl(req: any): string {
    const forwarded = headerValue(req, "x-forwarded-proto");
    const scheme = forwarded
        ? forwarded.split(",")[0].trim()
        : req?.socket?.encrypted === true
            ? "https"
            : "http";
    const host = headerValue(req, "host") || "localhost";
    return `${scheme}://${host}${typeof req?.url === "string" ? req.url : ""}`;
}

export function getParams(req: any): string {
    const url = typeof req?.url === "string" ? req.url : "";
    const q = url.indexOf("?");
    return q === -1 ? "" : url.slice(q + 1);
}

export function getRequestBody(req: any): string {
    return stringifyBody(req?.body, MAX_DATA_LENGTH);
}

export function getStatusCode(res: any): string {
    const code = res?.statusCode;
    return typeof code === "number" && code > 0 ? String(code) : "";
}

export function getResponseBody(res: any): string {
    const capture = res?.[HTTP_CAPTURE_KEY] as HttpCapture | undefined;
    return capture?.body ?? "";
}

function isTextualResponse(res: any): boolean {
    let contentType = "";
    try {
        contentType = String(res?.getHeader?.("content-type") ?? "").toLowerCase();
    } catch {
        return true;
    }
    return contentType === "" || TEXTUAL_CONTENT_TYPE.test(contentType);
}

// Called from the response patches for every chunk. Copy-and-forward: the
// caller always writes the chunk on regardless, so streaming is never delayed.
// The cap is cumulative, so a long SSE stream stops growing the capture.
export function appendResponseChunk(res: any, chunk: unknown): void {
    if (chunk === undefined || chunk === null || !res) return;
    let capture = res[HTTP_CAPTURE_KEY] as HttpCapture | undefined;
    if (!capture) {
        capture = { body: "", truncated: !isTextualResponse(res) };
        try {
            res[HTTP_CAPTURE_KEY] = capture;
        } catch {
            return; // frozen response object: capture nothing, serve normally
        }
    }
    if (capture.truncated) return;

    const remaining = MAX_STREAMING_CAPTURE_LENGTH - capture.body.length;
    if (remaining <= 0) {
        capture.truncated = true;
        return;
    }
    const text =
        typeof chunk === "string" ? chunk
        : Buffer.isBuffer(chunk) ? decodeCapped(chunk, remaining)
        : "";
    if (text.length >= remaining) {
        capture.body += text.slice(0, remaining);
        capture.truncated = true;
    } else {
        capture.body += text;
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/httpCapture.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/instrumentation/http/constants.ts src/instrumentation/http/capture.ts test/unit/httpCapture.test.ts
git commit -s -m "feat(http): add request and response capture helpers"
```

---

### Task 2: The http.process metamodel

The declarative attribute and event definitions, and proof that `processSpan` turns them into the attribute keys the spec fixes.

**Files:**
- Create: `src/instrumentation/metamodel/http/entities/httpProcess.ts`
- Test: `test/unit/httpProcessMetamodel.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces: `HTTP_PROCESS` — an output-processor object with `type`, `attributes` and `events`, passed to `processSpan` as `outputProcessor: [HTTP_PROCESS]`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/httpProcessMetamodel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { HTTP_PROCESS } from "../../src/instrumentation/metamodel/http/entities/httpProcess";
import { DefaultSpanHandler } from "../../src/instrumentation/common/spanHandler";
import { appendResponseChunk } from "../../src/instrumentation/http/capture";

// A span stub that records what processSpan writes. Using the real SDK span
// would drag in a provider; only the recorded calls matter here.
function fakeSpan(parentSpanId: string | undefined = "aaaabbbbccccdddd") {
    const attributes: Record<string, any> = {};
    const events: { name: string; attributes: Record<string, any> }[] = [];
    return {
        attributes,
        events,
        parentSpanContext: parentSpanId ? { spanId: parentSpanId } : undefined,
        setAttribute(k: string, v: any) { attributes[k] = v; return this; },
        addEvent(name: string, attrs: Record<string, any>) { events.push({ name, attributes: attrs }); return this; },
        setStatus() { return this; },
        end() { },
        spanContext() { return { traceId: "t", spanId: "s" }; },
        status: { code: SpanStatusCode.UNSET },
        kind: SpanKind.SERVER,
    } as any;
}

function apply(req: any, res: any, parentSpanId?: string) {
    const span = fakeSpan(parentSpanId);
    new DefaultSpanHandler().processSpan({
        span,
        instance: req,
        args: [req] as any,
        returnValue: res,
        outputProcessor: [HTTP_PROCESS],
        wrappedPackage: "node:http",
    });
    return span;
}

const req = {
    method: "POST",
    url: "/api/v1/ask?lang=en&verbose=true",
    baseUrl: "/api",
    route: { path: "/v1/ask" },
    headers: { host: "127.0.0.1:8123" },
    socket: {},
    body: { question: "What is Task Decomposition?" },
};

function resWith(body: string) {
    const res: any = { statusCode: 200, getHeader: () => "application/json" };
    appendResponseChunk(res, body);
    return res;
}

describe("http.process metamodel", () => {
    it("emits the attribute keys monocle_apptrace emits, at entity.1", () => {
        const span = apply(req, resWith('{"answer":"42"}'));
        expect(span.attributes["span.type"]).toBe("http.process");
        expect(span.attributes["entity.1.method"]).toBe("POST");
        expect(span.attributes["entity.1.route"]).toBe("/api/v1/ask");
        expect(span.attributes["entity.1.url"]).toBe("http://127.0.0.1:8123/api/v1/ask?lang=en&verbose=true");
    });

    it("emits data.input with params and request_body", () => {
        const span = apply(req, resWith("{}"));
        const input = span.events.find((e: any) => e.name === "data.input");
        expect(input.attributes).toEqual({
            params: "lang=en&verbose=true",
            request_body: '{"question":"What is Task Decomposition?"}',
        });
    });

    it("emits data.output with a string status_code and the response", () => {
        const span = apply(req, resWith('{"answer":"42"}'));
        const output = span.events.find((e: any) => e.name === "data.output");
        expect(output.attributes).toEqual({
            status_code: "200",
            response: '{"answer":"42"}',
        });
    });

    // Review Focus 4: an absent query must omit params rather than emit "".
    it("omits params entirely when there is no query string", () => {
        const span = apply({ ...req, url: "/api/v1/ask" }, resWith("{}"));
        const input = span.events.find((e: any) => e.name === "data.input");
        expect(input.attributes).not.toHaveProperty("params");
    });

    it("lands attributes at entity.3 when the span is the trace root, which is why the workflow span must be the parent", () => {
        const span = apply(req, resWith("{}"), undefined);
        expect(span.attributes["entity.3.method"]).toBe("POST");
        expect(span.attributes["entity.1.method"]).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/httpProcessMetamodel.test.ts`
Expected: FAIL — cannot resolve `httpProcess`.

- [ ] **Step 3: Write the metamodel**

Create `src/instrumentation/metamodel/http/entities/httpProcess.ts`:

```ts
import { SPAN_TYPES } from "../../../common/constants";
import {
    getMethod, getParams, getRequestBody, getResponseBody, getRoute, getStatusCode, getUrl,
} from "../../../http/capture";

// Entity accessors receive `output` for the response, event accessors receive
// `response` — different shapes for the same object. Using the wrong one yields
// a silently empty attribute, so the two halves below are not interchangeable.
export const HTTP_PROCESS = {
    "type": SPAN_TYPES.HTTP_PROCESS,
    "attributes": [
        [
            {
                "_comment": "request method",
                "attribute": "method",
                "accessor": function ({ instance }: any) {
                    return getMethod(instance);
                },
            },
            {
                "_comment": "matched route template when a framework supplied one, else the path",
                "attribute": "route",
                "accessor": function ({ instance }: any) {
                    return getRoute(instance);
                },
            },
            {
                "_comment": "full request URL, query string included",
                "attribute": "url",
                "accessor": function ({ instance }: any) {
                    return getUrl(instance);
                },
            },
        ],
    ],
    "events": [
        {
            "name": "data.input",
            "attributes": [
                {
                    "_comment": "raw query string, unparsed, as monocle_apptrace emits it",
                    "attribute": "params",
                    "accessor": function ({ instance }: any) {
                        return getParams(instance);
                    },
                },
                {
                    "_comment": "request body, present only when a body parser populated req.body",
                    "attribute": "request_body",
                    "accessor": function ({ instance }: any) {
                        return getRequestBody(instance);
                    },
                },
            ],
        },
        {
            "name": "data.output",
            "attributes": [
                {
                    "_comment": "HTTP status as a string, matching monocle_apptrace",
                    "attribute": "status_code",
                    "accessor": function ({ response }: any) {
                        return getStatusCode(response);
                    },
                },
                {
                    "_comment": "response body accumulated by the server hook's write patches",
                    "attribute": "response",
                    "accessor": function ({ response }: any) {
                        return getResponseBody(response);
                    },
                },
            ],
        },
    ],
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/httpProcessMetamodel.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/instrumentation/metamodel/http/entities/httpProcess.ts test/unit/httpProcessMetamodel.test.ts
git commit -s -m "feat(http): add the http.process metamodel"
```

---

### Task 3: Workflow-type holder

The hook creates the `workflow` span before any framework has run, so the type is resolved at the end. Context is immutable, so the channel is a mutable holder placed in the context at request start.

**Files:**
- Create: `src/instrumentation/common/workflowTypeHolder.ts`
- Modify: `src/instrumentation/common/spanHandler.ts` — inside `attachWorkflowType`
- Test: `test/unit/workflowTypeHolder.test.ts`

**Interfaces:**
- Consumes: `WORKFLOW_TYPE_GENERIC` from `src/instrumentation/common/constants.ts`.
- Produces:
  - `WORKFLOW_TYPE_HOLDER_KEY: symbol`
  - `interface WorkflowTypeHolder { type: string | null }`
  - `createWorkflowTypeHolder(): WorkflowTypeHolder`
  - `recordWorkflowType(holder: WorkflowTypeHolder | undefined, type: unknown): void`
  - `resolveWorkflowType(holder: WorkflowTypeHolder | undefined): string`

- [ ] **Step 1: Write the failing test**

Create `test/unit/workflowTypeHolder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { context } from "@opentelemetry/api";
import {
    WORKFLOW_TYPE_HOLDER_KEY, createWorkflowTypeHolder, recordWorkflowType, resolveWorkflowType,
} from "../../src/instrumentation/common/workflowTypeHolder";
import { attachWorkflowType } from "../../src/instrumentation/common/spanHandler";

describe("workflow type holder", () => {
    it("defaults to workflow.generic when nothing wrote to it", () => {
        expect(resolveWorkflowType(createWorkflowTypeHolder())).toBe("workflow.generic");
    });

    it("defaults to workflow.generic when there is no holder at all", () => {
        expect(resolveWorkflowType(undefined)).toBe("workflow.generic");
    });

    it("records the first non-generic type and ignores later ones", () => {
        const holder = createWorkflowTypeHolder();
        recordWorkflowType(holder, "workflow.adk");
        recordWorkflowType(holder, "workflow.langchain");
        expect(resolveWorkflowType(holder)).toBe("workflow.adk");
    });

    it("ignores a generic type so a later framework can still win", () => {
        const holder = createWorkflowTypeHolder();
        recordWorkflowType(holder, "workflow.generic");
        recordWorkflowType(holder, "workflow.adk");
        expect(resolveWorkflowType(holder)).toBe("workflow.adk");
    });

    it("is filled by attachWorkflowType when a holder is in context", () => {
        const holder = createWorkflowTypeHolder();
        const ctx = context.active().setValue(WORKFLOW_TYPE_HOLDER_KEY, holder);
        context.with(ctx, () => {
            attachWorkflowType({ package: "@google/adk" } as any);
        });
        expect(resolveWorkflowType(holder)).toBe("workflow.adk");
    });

    it("leaves attachWorkflowType working when no holder is present", () => {
        expect(() => attachWorkflowType({ package: "@google/adk" } as any)).not.toThrow();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/workflowTypeHolder.test.ts`
Expected: FAIL — cannot resolve `workflowTypeHolder`.

- [ ] **Step 3: Write the holder**

Create `src/instrumentation/common/workflowTypeHolder.ts`:

```ts
import { WORKFLOW_TYPE_GENERIC } from "./constants";

// The HTTP server hook opens the workflow span before any framework code runs,
// so the type is unknown at creation. Context is immutable, so a value set
// inside the handler cannot travel back out — this mutable holder is the channel.
export const WORKFLOW_TYPE_HOLDER_KEY = Symbol("monocle.workflowTypeHolder");

export interface WorkflowTypeHolder {
    type: string | null;
}

export function createWorkflowTypeHolder(): WorkflowTypeHolder {
    return { type: null };
}

// First non-generic wins: the outermost framework names the workflow, and a
// nested one must not rename it.
export function recordWorkflowType(holder: WorkflowTypeHolder | undefined, type: unknown): void {
    if (!holder || holder.type) return;
    if (typeof type === "string" && type && type !== WORKFLOW_TYPE_GENERIC) {
        holder.type = type;
    }
}

export function resolveWorkflowType(holder: WorkflowTypeHolder | undefined): string {
    return holder?.type ?? WORKFLOW_TYPE_GENERIC;
}
```

- [ ] **Step 4: Write into the holder from attachWorkflowType**

In `src/instrumentation/common/spanHandler.ts`, add to the imports:

```ts
import { recordWorkflowType, WORKFLOW_TYPE_HOLDER_KEY, WorkflowTypeHolder } from "./workflowTypeHolder";
```

Replace the body of `attachWorkflowType` so the resolved type is also recorded:

```ts
export function attachWorkflowType(element?: WrapperArguments) {
    let activeContext = context.active();
    let currentWorkflowType = activeContext.getValue(WORKFLOW_TYPE_KEY_SYMBOL);
    if (!element) {
        activeContext = activeContext.setValue(WORKFLOW_TYPE_KEY_SYMBOL, WORKFLOW_TYPE_GENERIC);
        return activeContext;
    }
    if (!currentWorkflowType || currentWorkflowType === WORKFLOW_TYPE_GENERIC) {
        const resolved = getWorkflowType(element?.package);
        // The HTTP hook's workflow span is already open and cannot read this
        // context, so hand the type to its holder as well.
        recordWorkflowType(
            activeContext.getValue(WORKFLOW_TYPE_HOLDER_KEY) as WorkflowTypeHolder | undefined,
            resolved,
        );
        activeContext = context.active().setValue(WORKFLOW_TYPE_KEY_SYMBOL, resolved);
    }

    return activeContext;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/workflowTypeHolder.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Verify nothing else regressed**

Run: `npm run test:unit`
Expected: every existing test still passes.

- [ ] **Step 7: Commit**

```bash
git add src/instrumentation/common/workflowTypeHolder.ts src/instrumentation/common/spanHandler.ts test/unit/workflowTypeHolder.test.ts
git commit -s -m "feat(http): carry the resolved workflow type out of the request context"
```

---

### Task 4: The server hook and the trace-return cutover

This is one atomic change: the new hook cannot coexist with the old one, because both would patch `Server.prototype.emit` and both would own `res.end`.

**Files:**
- Create: `src/instrumentation/http/serverHook.ts`
- Modify: `src/traceReturn/httpHook.ts` — reduced to registering trailer callbacks
- Delete: `src/traceReturn/requestSpan.ts`
- Modify: `src/traceReturn/index.ts` — drop the `requestSpan` re-exports
- Delete: `test/unit/traceReturnRequestSpan.test.ts`

`src/instrumentation/common/instrumentation.ts` needs **no change**:
`installTraceReturnHttpHook()` keeps its name and call site at line 432, and now
registers the trailer callbacks and delegates to `installHttpServerHook()`.
- Test: `test/unit/httpServerHook.test.ts`

**Interfaces:**
- Consumes: Task 1's `appendResponseChunk` and `HTTP_CAPTURE_KEY`; Task 2's `HTTP_PROCESS`; Task 3's holder functions.
- Produces:
  - `installHttpServerHook(): void`
  - `interface HttpRequestHooks { onRequestStart?(req, res): void; onBeforeEnd?(req, res, traceId: string): Buffer | null }`
  - `registerHttpRequestHooks(hooks: HttpRequestHooks): void`

- [ ] **Step 1: Write the failing test**

Create `test/unit/httpServerHook.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "http";
import { SpanProcessor } from "@opentelemetry/sdk-trace-node";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

const finished: ReadableSpan[] = [];
const collector: SpanProcessor = {
    onStart() { },
    onEnd(span) { finished.push(span); },
    shutdown() { return Promise.resolve(); },
    forceFlush() { return Promise.resolve(); },
};

let port = 0;
let server: any;

function post(path: string, body: string) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
            { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
            },
        );
        req.on("error", reject);
        req.end(body);
    });
}

beforeAll(async () => {
    process.env.MONOCLE_ENABLE_TRACE_RETURN = "true";
    const monocle = await import("../../src/index");
    monocle.setupMonocle("http-span-demo", [collector]);

    const express = (await import("express")).default;
    const app = express();
    app.use(express.json());
    const router = express.Router();
    router.post("/v1/ask", (req: any, res: any) => {
        res.json({ answer: `You asked: ${req.body.question}` });
    });
    app.use("/api", router);

    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    port = server.address().port;
});

afterAll(() => server?.close());

function spanNamed(type: string) {
    return finished.find((s) => s.attributes["span.type"] === type);
}

describe("http server hook", () => {
    beforeAll(async () => {
        finished.length = 0;
        await post("/api/v1/ask?lang=en", JSON.stringify({ question: "What is Task Decomposition?" }));
    });

    it("emits an http.process span", () => {
        expect(spanNamed("http.process")).toBeDefined();
    });

    it("puts the workflow span above it, so attributes land at entity.1", () => {
        const httpSpan = spanNamed("http.process")!;
        const workflow = spanNamed("workflow")!;
        expect(httpSpan.parentSpanContext?.spanId).toBe(workflow.spanContext().spanId);
        expect(workflow.parentSpanContext?.spanId).toBeUndefined();
        expect(httpSpan.attributes["entity.1.method"]).toBe("POST");
    });

    it("captures the route template, not the concrete path", () => {
        expect(spanNamed("http.process")!.attributes["entity.1.route"]).toBe("/api/v1/ask");
    });

    it("captures request and response bodies through the real Express stack", () => {
        const httpSpan = spanNamed("http.process")!;
        const input = httpSpan.events.find((e) => e.name === "data.input")!;
        const output = httpSpan.events.find((e) => e.name === "data.output")!;
        expect(input.attributes!.request_body).toBe('{"question":"What is Task Decomposition?"}');
        expect(input.attributes!.params).toBe("lang=en");
        expect(output.attributes!.status_code).toBe("200");
        expect(output.attributes!.response).toContain("You asked:");
    });

    it("names the span by method and route", () => {
        expect(spanNamed("http.process")!.name).toBe("POST /api/v1/ask");
    });

    it("uses SpanKind.SERVER", () => {
        expect(spanNamed("http.process")!.kind).toBe(1); // SpanKind.SERVER
    });

    it("serves the response unchanged", async () => {
        const res = await post("/api/v1/ask", JSON.stringify({ question: "ping" }));
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ answer: "You asked: ping" });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/httpServerHook.test.ts`
Expected: FAIL — no `http.process` span is emitted.

- [ ] **Step 3: Write the server hook**

Create `src/instrumentation/http/serverHook.ts`:

```ts
import * as http from "http";
import * as https from "https";
import type { IncomingMessage, ServerResponse } from "http";
import {
    Context, SpanKind, SpanStatusCode, context as contextApi, propagation, trace,
} from "@opentelemetry/api";
import { consoleLog } from "../../common/logging";
import { Span as MonocleSpan } from "../common/opentelemetryUtils";
import { DefaultSpanHandler } from "../common/spanHandler";
import { getInstrumentor, get_http_scopes, updateBaggageContextWithScopes } from "../common/utils";
import {
    WORKFLOW_TYPE_HOLDER_KEY, createWorkflowTypeHolder, resolveWorkflowType,
} from "../common/workflowTypeHolder";
import { HTTP_PROCESS } from "../metamodel/http/entities/httpProcess";
import { appendResponseChunk, getRoute } from "./capture";

const HOOK_INSTALLED = Symbol.for("monocle2ai.httpServerHook");

export interface HttpRequestHooks {
    onRequestStart?(req: IncomingMessage, res: ServerResponse): void;
    onBeforeEnd?(req: IncomingMessage, res: ServerResponse, traceId: string): Buffer | null;
}

const registered: HttpRequestHooks[] = [];

// Dependency inversion: trace return registers here rather than this module
// importing it, so the span path stays free of trace-return concerns and can be
// enabled independently later.
export function registerHttpRequestHooks(hooks: HttpRequestHooks): void {
    registered.push(hooks);
}

export function installHttpServerHook(): void {
    const g = globalThis as any;
    if (g[HOOK_INSTALLED]) return;
    g[HOOK_INSTALLED] = true;

    for (const mod of [http, https] as any[]) {
        const proto = mod?.Server?.prototype;
        if (!proto || typeof proto.emit !== "function") continue;
        patchEmit(proto);
    }
    consoleLog("[monocle] http server hook installed");
}

function patchEmit(proto: any): void {
    const originalEmit = proto.emit;
    proto.emit = function monocleHttpEmit(this: any, event: string, ...args: any[]) {
        if (event !== "request") return originalEmit.apply(this, [event, ...args]);
        const [req, res] = args as [IncomingMessage, ServerResponse];
        const passthrough = () => originalEmit.apply(this, [event, ...args]);

        try {
            const started = startRequest(req, res);
            if (!started) return passthrough();
            return contextApi.with(started, passthrough);
        } catch (e) {
            console.warn(`[monocle] http hook failed, serving request untouched: ${e}`);
            return passthrough();
        }
    };
}

// Scopes configured with an http_header are imported here. get_http_scopes() has
// been populated by load_scopes() since it was written and read by nothing; this
// is its first consumer.
function importedScopes(req: IncomingMessage): Record<string, string> {
    const scopes: Record<string, string> = {};
    for (const [header, scopeName] of Object.entries(get_http_scopes())) {
        const value = req.headers[header];
        if (typeof value === "string") scopes[scopeName] = `${header}: ${value}`;
    }
    return scopes;
}

function startRequest(req: IncomingMessage, res: ServerResponse): Context | null {
    const instrumentor = getInstrumentor();
    if (!instrumentor) {
        consoleLog("[monocle] http hook: setupMonocle has not run; no request span");
        return null;
    }
    const tracer = instrumentor.getTracer();

    // An incoming traceparent makes this request a continuation of the caller's
    // trace rather than a new one.
    let ctx = propagation.extract(contextApi.active(), req.headers);

    const scopes = importedScopes(req);
    for (const hooks of registered) hooks.onRequestStart?.(req, res);
    if (Object.keys(scopes).length) ctx = updateBaggageContextWithScopes(ctx, scopes);

    const holder = createWorkflowTypeHolder();
    ctx = ctx.setValue(WORKFLOW_TYPE_HOLDER_KEY, holder);

    // The workflow span is the trace root and the http.process span its child.
    // That ordering is what puts the HTTP attributes at entity.1 rather than
    // entity.3, matching monocle_apptrace.
    const workflowSpan = tracer.startSpan("workflow", { kind: SpanKind.INTERNAL }, ctx);
    ctx = trace.setSpan(ctx, workflowSpan);

    const route = getRoute(req);
    const httpSpan = tracer.startSpan(
        `${req.method ?? ""} ${route}`.trim(),
        { kind: SpanKind.SERVER },
        ctx,
    );
    ctx = trace.setSpan(ctx, httpSpan);

    // Inside ctx: setMonocleAttributes reads scopes off the ACTIVE context's
    // baggage, so called outside it the spans would miss their scope attributes.
    contextApi.with(ctx, () => {
        DefaultSpanHandler.setMonocleAttributes(workflowSpan as MonocleSpan, null);
        DefaultSpanHandler.setMonocleAttributes(httpSpan as MonocleSpan, null);
    });

    installResponsePatches(req, res, {
        workflowSpan,
        httpSpan,
        holder,
        traceId: httpSpan.spanContext().traceId,
    });
    return ctx;
}

interface RequestState {
    workflowSpan: any;
    httpSpan: any;
    holder: ReturnType<typeof createWorkflowTypeHolder>;
    traceId: string;
}

function finish(req: IncomingMessage, res: ServerResponse, state: RequestState, aborted: boolean): void {
    const { workflowSpan, httpSpan, holder } = state;

    try {
        new DefaultSpanHandler().processSpan({
            span: httpSpan,
            instance: req,
            args: [req] as any,
            returnValue: res,
            outputProcessor: [HTTP_PROCESS],
            wrappedPackage: "node:http",
        });
    } catch (e) {
        consoleLog(`[monocle] http hook: could not apply the metamodel: ${e}`);
    }

    if (aborted) {
        httpSpan.setStatus({ code: SpanStatusCode.ERROR, message: "client disconnected" });
    } else if (res.statusCode >= 500) {
        httpSpan.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.statusCode}` });
    } else {
        httpSpan.setStatus({ code: SpanStatusCode.OK, message: "OK" });
    }
    httpSpan.end();

    // The workflow span's type is only knowable now, after the framework has run.
    // setWorkflowAttributes fills entity.1.name and a generic entity.1.type off the
    // context; the holder then supplies the framework-specific type it could not know.
    DefaultSpanHandler.setWorkflowAttributes({ span: workflowSpan });
    DefaultSpanHandler.setAppHostingIdentifierAttribute(workflowSpan);
    workflowSpan.setAttribute("entity.1.type", resolveWorkflowType(holder));
    workflowSpan.setStatus({ code: SpanStatusCode.OK, message: "OK" });
    workflowSpan.end();
}

function installResponsePatches(req: IncomingMessage, res: ServerResponse, state: RequestState): void {
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    let finished = false;

    res.write = function (this: ServerResponse, ...args: any[]) {
        appendResponseChunk(res, args[0]);
        return (origWrite as any)(...args);
    } as any;

    res.end = function (this: ServerResponse, chunk?: any, encoding?: any, callback?: any) {
        if (typeof chunk === "function") { callback = chunk; chunk = undefined; encoding = undefined; }
        else if (typeof encoding === "function") { callback = encoding; encoding = undefined; }

        if (finished) return (origEnd as any)(chunk, encoding, callback);
        finished = true;

        try {
            if (chunk !== undefined && chunk !== null) {
                appendResponseChunk(res, chunk);
                (origWrite as any)(chunk, encoding);
            }
            // Spans end BEFORE any registered hook runs: SimpleSpanProcessor hands
            // them over synchronously, so a trailer built here contains them.
            finish(req, res, state, false);

            for (const hooks of registered) {
                const extra = hooks.onBeforeEnd?.(req, res, state.traceId);
                if (extra) (origWrite as any)(extra);
            }
        } catch (e) {
            console.warn(`[monocle] http hook: response finalisation failed: ${e}`);
        }
        return (origEnd as any)(callback);
    } as any;
}
```

- [ ] **Step 4: Reduce the trace-return hook to trailer callbacks**

Replace the whole of `src/traceReturn/httpHook.ts` with:

```ts
import type { IncomingMessage, ServerResponse } from "http";
import { consoleLog } from "../common/logging";
import { installHttpServerHook, registerHttpRequestHooks } from "../instrumentation/http/serverHook";
import { TRACE_RETURN_REQUEST_HEADER, TRACE_RETURN_RESPONSE_HEADER, TRACE_RETURN_SCOPE_NAME } from "./constants";
import { buildResponseHeaderValue, buildTrailerBytes, makeDelimiter } from "./codec";
import { getTraceReturnExporter } from "./exporter";
import { getHeaderCaseInsensitive, isTraceReturnAuthorized, isTraceReturnEnabled } from "./gate";

const HOOK_INSTALLED = Symbol.for("monocle2ai.traceReturnHttpHook");
const DELIMITER_KEY = Symbol("monocle.traceReturnDelimiter");

export function installTraceReturnHttpHook(): void {
    const g = globalThis as any;
    if (g[HOOK_INSTALLED]) return;
    g[HOOK_INSTALLED] = true;

    registerHttpRequestHooks({ onRequestStart, onBeforeEnd });
    installHttpServerHook();
    consoleLog("[monocle] trace return: trailer hooks registered");
}

function onRequestStart(req: IncomingMessage, res: ServerResponse): void {
    if (!isTraceReturnEnabled()) return;
    if (getHeaderCaseInsensitive(req.headers, TRACE_RETURN_REQUEST_HEADER) === undefined) return;
    if (!isTraceReturnAuthorized(req.headers)) {
        consoleLog("[monocle] trace return: request not authorized");
        return;
    }

    // Our write patch runs innermost, so a compression middleware above would
    // hand us gzipped bytes and the plaintext trailer would land after a
    // finished member. Encoders honour accept-encoding, so dropping it is enough.
    delete req.headers["accept-encoding"];

    const delimiter = makeDelimiter();
    (res as any)[DELIMITER_KEY] = delimiter;
    res.setHeader(TRACE_RETURN_RESPONSE_HEADER, buildResponseHeaderValue(delimiter));
    dropContentLength(res);
    patchWriteHead(res);
}

function onBeforeEnd(_req: IncomingMessage, res: ServerResponse, traceId: string): Buffer | null {
    const delimiter = (res as any)[DELIMITER_KEY] as string | undefined;
    if (!delimiter) return null;

    const spans = getTraceReturnExporter().popSpansForTrace(traceId);
    if (!spans.length) {
        consoleLog("[monocle] trace return: no spans buffered for this request");
        return null;
    }
    if (res.getHeader("content-encoding")) {
        console.warn("[monocle] trace return: response is content-encoded, skipping trailer.");
        return null;
    }
    return buildTrailerBytes(spans, delimiter);
}

// Appending past a declared Content-Length truncates the response. Dropping it
// falls back to chunked encoding, which — unlike recomputing the length — needs
// no buffering, so streaming still works.
function dropContentLength(res: ServerResponse): void {
    if (res.headersSent) return;
    try { res.removeHeader("Content-Length"); } catch { /* already flushed */ }
}

function patchWriteHead(res: ServerResponse): void {
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = function (this: ServerResponse, ...args: any[]) {
        const headers = args[args.length - 1];
        if (headers && typeof headers === "object" && !Array.isArray(headers)) {
            for (const key of Object.keys(headers)) {
                if (key.toLowerCase() === "content-length") delete headers[key];
            }
        }
        const out = origWriteHead(...(args as [any]));
        dropContentLength(res);
        return out;
    } as any;
}

// The scope must be applied only to authorized requests: the exporter buffers
// every span carrying it until a response pops them, so tagging unauthorized
// traffic would fill that buffer with traces nobody claims.
export function traceReturnScopes(req: IncomingMessage): Record<string, string | null> | null {
    if (!isTraceReturnEnabled()) return null;
    if (getHeaderCaseInsensitive(req.headers, TRACE_RETURN_REQUEST_HEADER) === undefined) return null;
    if (!isTraceReturnAuthorized(req.headers)) return null;
    return { [TRACE_RETURN_SCOPE_NAME]: null };
}
```

Then in `src/instrumentation/http/serverHook.ts`, extend `HttpRequestHooks` with a scope contribution so the scope tag stays inside trace return:

```ts
export interface HttpRequestHooks {
    onRequestStart?(req: IncomingMessage, res: ServerResponse): void;
    scopesFor?(req: IncomingMessage): Record<string, string | null> | null;
    onBeforeEnd?(req: IncomingMessage, res: ServerResponse, traceId: string): Buffer | null;
}
```

and in `startRequest`, after `importedScopes`:

```ts
    for (const hooks of registered) {
        const extra = hooks.scopesFor?.(req);
        if (extra) ctx = updateBaggageContextWithScopes(ctx, extra);
    }
```

Register it from `installTraceReturnHttpHook`:

```ts
    registerHttpRequestHooks({ onRequestStart, scopesFor: traceReturnScopes, onBeforeEnd });
```

- [ ] **Step 5: Delete the absorbed module and its test**

```bash
git rm src/traceReturn/requestSpan.ts test/unit/traceReturnRequestSpan.test.ts
```

Remove these two lines from `src/traceReturn/index.ts`:

```ts
export { startTraceReturnRequest } from "./requestSpan";
export type { TraceReturnRequest, StartTraceReturnRequestOptions } from "./requestSpan";
```

and update the file's header comment, which currently promises `startTraceReturnRequest` for adapters:

```ts
// Public surface for HTTP trace return. Nothing here is needed normally — with
// MONOCLE_ENABLE_TRACE_RETURN set, setupMonocle installs the hook and the
// feature is automatic. These exist for adapters the hook cannot reach (Lambda,
// Azure Functions, Web Request/Response), where you assemble the trailer.
```

- [ ] **Step 6: Run the new test**

Run: `npx vitest run test/unit/httpServerHook.test.ts`
Expected: PASS, all tests.

- [ ] **Step 7: Verify trace return still works end to end**

Run: `npx vitest run test/unit/traceReturnHttpHook.test.ts test/unit/traceReturnWiring.test.ts`
Expected: PASS. These exercise compression ordering and the span payload, which is exactly what the cutover could break.

- [ ] **Step 8: Full unit suite and typecheck**

Run: `npm run test:unit && npx tsc --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 9: Commit**

```bash
git add -A src/instrumentation/http src/traceReturn src/instrumentation/common/instrumentation.ts test/unit
git commit -s -m "feat(http): open an http.process span under a workflow span per request"
```

---

### Task 5: Client-abort backstop

If the client disconnects mid-response, `res.end` may never run, so today the span never ends and the request vanishes from the trace entirely. This is a pre-existing trace-return defect, fixed here because this work owns the path.

**Files:**
- Modify: `src/instrumentation/http/serverHook.ts` — `installResponsePatches`
- Test: `test/unit/httpServerHookAbort.test.ts`

**Interfaces:**
- Consumes: Task 4's `RequestState` and `finish`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `test/unit/httpServerHookAbort.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "http";
import { SpanProcessor } from "@opentelemetry/sdk-trace-node";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

const finished: ReadableSpan[] = [];
const collector: SpanProcessor = {
    onStart() { },
    onEnd(span) { finished.push(span); },
    shutdown() { return Promise.resolve(); },
    forceFlush() { return Promise.resolve(); },
};

let port = 0;
let server: any;

beforeAll(async () => {
    process.env.MONOCLE_ENABLE_TRACE_RETURN = "true";
    const monocle = await import("../../src/index");
    monocle.setupMonocle("http-abort-demo", [collector]);

    const express = (await import("express")).default;
    const app = express();
    // Writes headers, then never ends: the client aborts while the handler hangs.
    app.get("/hang", (_req: any, res: any) => {
        res.write("partial");
    });

    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    port = server.address().port;
});

afterAll(() => server?.close());

describe("client abort", () => {
    it("ends the http.process span instead of losing the request", async () => {
        finished.length = 0;

        await new Promise<void>((resolve) => {
            const req = http.request({ host: "127.0.0.1", port, path: "/hang", method: "GET" }, (res) => {
                res.on("data", () => req.destroy());
            });
            req.on("error", () => resolve());
            req.end();
        });

        // The close event is asynchronous; give the server a tick to observe it.
        await new Promise((r) => setTimeout(r, 200));

        const httpSpan = finished.find((s) => s.attributes["span.type"] === "http.process");
        expect(httpSpan).toBeDefined();
        expect(httpSpan!.status.code).toBe(2); // SpanStatusCode.ERROR
        expect(httpSpan!.status.message).toBe("client disconnected");
    });

    it("ends the workflow span too, so the trace is not left open", () => {
        expect(finished.find((s) => s.attributes["span.type"] === "workflow")).toBeDefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/httpServerHookAbort.test.ts`
Expected: FAIL — no `http.process` span is emitted, because it never ended.

- [ ] **Step 3: Add the backstop**

In `src/instrumentation/http/serverHook.ts`, inside `installResponsePatches`, after the `res.end` assignment:

```ts
    // res.end may never run if the client disconnects mid-response. Without this
    // the span never ends, never reaches the exporter, and the request vanishes
    // from the trace with no indication why.
    res.on("close", () => {
        if (finished) return;
        finished = true;
        try {
            finish(req, res, state, true);
        } catch (e) {
            console.warn(`[monocle] http hook: abort finalisation failed: ${e}`);
        }
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/httpServerHookAbort.test.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Confirm the normal path did not regress**

Run: `npm run test:unit && npx tsc --noEmit`
Expected: all pass. `res.on("close")` fires on every response, so the `finished` guard is what keeps a normal request from being finalised twice — if that guard is wrong, Task 4's tests fail here.

- [ ] **Step 6: Commit**

```bash
git add src/instrumentation/http/serverHook.ts test/unit/httpServerHookAbort.test.ts
git commit -s -m "fix(http): end the request span when the client disconnects"
```

---

### Task 6: Excluded paths

Must land BEFORE Task 7. Flipping the gate without this ships the noise problem
and removes the only lever for keeping credentials out of traces.

**Files:**
- Modify: `src/instrumentation/http/constants.ts` — add the env var name
- Create: `src/instrumentation/http/excludePaths.ts`
- Modify: `src/instrumentation/http/serverHook.ts` — bail out in `patchEmit` before any work
- Test: `test/unit/httpExcludePaths.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `MONOCLE_HTTP_EXCLUDE_PATHS_ENV = "MONOCLE_HTTP_EXCLUDE_PATHS"`
  - `isPathExcluded(url: string | undefined): boolean`
  - `resetExcludedPathsForTests(): void`

- [ ] **Step 1: Write the failing test**

Create `test/unit/httpExcludePaths.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { isPathExcluded, resetExcludedPathsForTests } from "../../src/instrumentation/http/excludePaths";

function withEnv(value: string | undefined, fn: () => void) {
    const previous = process.env.MONOCLE_HTTP_EXCLUDE_PATHS;
    if (value === undefined) delete process.env.MONOCLE_HTTP_EXCLUDE_PATHS;
    else process.env.MONOCLE_HTTP_EXCLUDE_PATHS = value;
    resetExcludedPathsForTests();
    try { fn(); } finally {
        if (previous === undefined) delete process.env.MONOCLE_HTTP_EXCLUDE_PATHS;
        else process.env.MONOCLE_HTTP_EXCLUDE_PATHS = previous;
        resetExcludedPathsForTests();
    }
}

afterEach(() => resetExcludedPathsForTests());

describe("excluded paths", () => {
    it("excludes nothing when the variable is unset", () => {
        withEnv(undefined, () => {
            expect(isPathExcluded("/health")).toBe(false);
            expect(isPathExcluded("/api/v1/ask")).toBe(false);
        });
    });

    it("excludes nothing when the variable is empty or only separators", () => {
        withEnv("", () => expect(isPathExcluded("/health")).toBe(false));
        withEnv("  , ,, ", () => expect(isPathExcluded("/health")).toBe(false));
    });

    it("matches by prefix, so /health covers /health/ready", () => {
        withEnv("/health", () => {
            expect(isPathExcluded("/health")).toBe(true);
            expect(isPathExcluded("/health/ready")).toBe(true);
        });
    });

    it("handles a comma-separated list and trims whitespace", () => {
        withEnv(" /health , /metrics ", () => {
            expect(isPathExcluded("/health")).toBe(true);
            expect(isPathExcluded("/metrics")).toBe(true);
            expect(isPathExcluded("/api")).toBe(false);
        });
    });

    it("ignores the query string when matching", () => {
        withEnv("/health", () => expect(isPathExcluded("/health?verbose=1")).toBe(true));
    });

    // A prefix must not match a longer, unrelated path segment.
    it("does not let /health match /healthcheck-api", () => {
        withEnv("/health/", () => expect(isPathExcluded("/healthcheck-api")).toBe(false));
    });

    it("treats an absent url as not excluded", () => {
        withEnv("/health", () => expect(isPathExcluded(undefined)).toBe(false));
    });

    // Secrets case: this is the lever that makes unredacted body capture defensible.
    it("excludes a credential endpoint so its body is never captured", () => {
        withEnv("/login,/oauth/token", () => {
            expect(isPathExcluded("/login")).toBe(true);
            expect(isPathExcluded("/oauth/token")).toBe(true);
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/httpExcludePaths.test.ts`
Expected: FAIL — cannot resolve `excludePaths`.

- [ ] **Step 3: Add the env var name**

Append to `src/instrumentation/http/constants.ts`:

```ts
// Comma-separated path prefixes served with no hook involvement at all. Keeps
// probe traffic out of the trace, and is the only lever for keeping a
// credential endpoint's body out of an exporter, since bodies are not redacted.
export const MONOCLE_HTTP_EXCLUDE_PATHS_ENV = "MONOCLE_HTTP_EXCLUDE_PATHS";
```

- [ ] **Step 4: Write the module**

Create `src/instrumentation/http/excludePaths.ts`:

```ts
import { MONOCLE_HTTP_EXCLUDE_PATHS_ENV } from "./constants";

// Read once: this runs on every request, and the variable cannot change
// meaningfully mid-process. resetExcludedPathsForTests clears the cache.
let cached: string[] | null = null;

function excludedPrefixes(): string[] {
    if (cached) return cached;
    cached = (process.env[MONOCLE_HTTP_EXCLUDE_PATHS_ENV] ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
    return cached;
}

export function resetExcludedPathsForTests(): void {
    cached = null;
}

// Matched against the raw path with the query stripped: the route template is
// not known this early, which is the price of skipping the work entirely.
export function isPathExcluded(url: string | undefined): boolean {
    const prefixes = excludedPrefixes();
    if (!prefixes.length || typeof url !== "string") return false;
    const q = url.indexOf("?");
    const path = q === -1 ? url : url.slice(0, q);
    return prefixes.some((prefix) => path.startsWith(prefix));
}
```

- [ ] **Step 5: Bail out in the hook before any work**

In `src/instrumentation/http/serverHook.ts`, import it:

```ts
import { isPathExcluded } from "./excludePaths";
```

and make it the first thing `patchEmit`'s request branch checks, before
`startRequest` and before any registered hook runs:

```ts
        try {
            // Before anything else: an excluded path is served exactly as if
            // Monocle were not installed — no spans, no response patches.
            if (isPathExcluded(req.url)) return passthrough();
            const started = startRequest(req, res);
```

- [ ] **Step 6: Add a server-level test**

Append to `test/unit/httpServerHook.test.ts` a case proving exclusion reaches the
real server path, not just the predicate:

```ts
describe("excluded paths", () => {
    it("emits no spans at all for an excluded path", async () => {
        process.env.MONOCLE_HTTP_EXCLUDE_PATHS = "/health";
        const { resetExcludedPathsForTests } = await import("../../src/instrumentation/http/excludePaths");
        resetExcludedPathsForTests();
        finished.length = 0;
        try {
            await post("/health", "{}");
            expect(finished.filter((s) => s.attributes["span.type"] === "http.process")).toHaveLength(0);
            expect(finished.filter((s) => s.attributes["span.type"] === "workflow")).toHaveLength(0);
        } finally {
            delete process.env.MONOCLE_HTTP_EXCLUDE_PATHS;
            resetExcludedPathsForTests();
        }
    });
});
```

You will need a `/health` route on the test app; add it next to the existing
routes in that file's `beforeAll`.

- [ ] **Step 7: Run tests**

Run: `npx vitest run test/unit/httpExcludePaths.test.ts test/unit/httpServerHook.test.ts`
Expected: PASS.

- [ ] **Step 8: Full suite and typecheck**

Run: `npm run test:unit && npx tsc --noEmit`
Expected: all pass.

---

### Task 7: Install the hook unconditionally

The requirement change of 2026-09-24: HTTP spans are ordinary spans, produced
whether or not trace return is enabled.

**Files:**
- Modify: `src/instrumentation/common/instrumentation.ts` — around line 432
- Modify: `README.md` — operator documentation for `MONOCLE_HTTP_EXCLUDE_PATHS`
- Modify: `.env.example` — the same variable, since README points there as the canonical list
- Test: `test/unit/httpSpansWithoutTraceReturn.test.ts`

**Documentation is part of this task, not a follow-up.** Until this task the hook
ran only in test mode. Afterwards it runs in every application, capturing request
and response bodies with no redaction, and `MONOCLE_HTTP_EXCLUDE_PATHS` is the
only mechanism keeping a credential endpoint out of an exporter. Shipping the gate
flip without the documentation ships the exposure without the lever. Cover: prefix
(not exact) matching; that `/health` also covers `/healthcheck-api`; that a
trailing slash narrows to the subtree and excludes a bare `/health`; that prefixes
must start with `/`; case-insensitive normalised-path matching; that unset excludes
nothing; that an excluded request is served as if Monocle were absent; and the body
caps — 1000 characters for request bodies, 5000 for all response bodies.

**Interfaces:**
- Consumes: `installHttpServerHook` from Task 4; `isPathExcluded` from Task 6.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `test/unit/httpSpansWithoutTraceReturn.test.ts`. Note what makes this test
meaningful: `MONOCLE_ENABLE_TRACE_RETURN` is explicitly deleted, so it fails
against today's code where the hook only installs under that flag.

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "http";
import { SpanProcessor } from "@opentelemetry/sdk-trace-node";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

const finished: ReadableSpan[] = [];
const collector: SpanProcessor = {
    onStart() { },
    onEnd(span) { finished.push(span); },
    shutdown() { return Promise.resolve(); },
    forceFlush() { return Promise.resolve(); },
};

let port = 0;
let server: any;

function get(path: string) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
        });
        req.on("error", reject);
        req.end();
    });
}

beforeAll(async () => {
    // The point of this file: trace return is OFF.
    delete process.env.MONOCLE_ENABLE_TRACE_RETURN;
    const monocle = await import("../../src/index");
    monocle.setupMonocle("http-spans-no-trace-return", [collector]);

    const express = (await import("express")).default;
    const app = express();
    app.get("/ping", (_req: any, res: any) => res.json({ ok: true }));
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    port = server.address().port;
});

afterAll(() => server?.close());

describe("http spans without trace return", () => {
    beforeAll(async () => {
        finished.length = 0;
        await get("/ping");
    });

    it("emits an http.process span", () => {
        const span = finished.find((s) => s.attributes["span.type"] === "http.process");
        expect(span).toBeDefined();
        expect(span!.attributes["entity.1.method"]).toBe("GET");
        expect(span!.attributes["entity.1.route"]).toBe("/ping");
    });

    it("emits the workflow span above it", () => {
        const httpSpan = finished.find((s) => s.attributes["span.type"] === "http.process")!;
        const workflow = finished.find((s) => s.attributes["span.type"] === "workflow")!;
        expect(httpSpan.parentSpanContext?.spanId).toBe(workflow.spanContext().spanId);
    });

    it("tags nothing with the trace-return scope", () => {
        for (const span of finished) {
            expect(span.attributes["scope.monocle_trace_return"]).toBeUndefined();
        }
    });

    it("adds no trace-return response header", async () => {
        const res = await get("/ping");
        expect(res.status).toBe(200);
    });

    it("leaves the trace-return exporter buffer empty", async () => {
        const { getTraceReturnExporter } = await import("../../src/traceReturn/exporter");
        expect(getTraceReturnExporter().pendingTraceCount).toBe(0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/httpSpansWithoutTraceReturn.test.ts`
Expected: FAIL — no `http.process` span, because the hook is not installed.

- [ ] **Step 3: Install the hook unconditionally**

In `src/instrumentation/common/instrumentation.ts`, add to the imports:

```ts
import { installHttpServerHook } from '../http/serverHook';
```

Then at the site that currently reads:

```ts
        const traceReturnProcessor = maybeTraceReturnProcessor();
        ...
            installTraceReturnHttpHook();
```

install the HTTP hook outside that conditional, so it runs on every setup, and
leave `installTraceReturnHttpHook()` where it is inside the trace-return branch.
Order matters only in that both are idempotent via their `Symbol.for` guards, so
either may run first:

```ts
        // HTTP spans are ordinary instrumentation: the hook installs for every
        // app, like any other metamodel. Trace return, when enabled, registers
        // its trailer callbacks on top of the same hook.
        installHttpServerHook();
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/httpSpansWithoutTraceReturn.test.ts`
Expected: PASS, all five.

- [ ] **Step 5: Confirm trace return still works**

Run: `npx vitest run test/unit/traceReturnHttpHook.test.ts test/unit/traceReturnWiring.test.ts test/unit/httpServerHook.test.ts`
Expected: PASS. Trace return must be unaffected by the hook installing earlier
and independently.

- [ ] **Step 6: Full suite and typecheck**

Run: `npm run test:unit && npx tsc --noEmit`
Expected: all pass. Watch for suites that assert on span counts or tree depth —
every test app in the suite that serves HTTP now gets two extra spans. If one
fails for that reason, it is a real consequence of the requirement change, not a
flake: fix the assertion and say so in your report.

---

## Verification

After Task 7, the whole feature should hold together:

- [ ] `npm run test:unit` — every unit test passes.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run lint` — clean.
- [ ] Rebuild and pack for the demo: `npm run build && cd dist && npm pack`, then install the tarball in `adk-remote-agent-test` and run its pytest suite. The returned trace should contain an `http.process` span with `entity.1.method`, `entity.1.route` and both events. This is the real validation, per the spec.
- [ ] Run the same demo with trace return switched OFF and confirm HTTP spans still reach its file exporter. That is the requirement change of 2026-09-24, and the unit test for it uses a synthetic server rather than the real app.
- [ ] Set `MONOCLE_HTTP_EXCLUDE_PATHS` in the demo and confirm the excluded route produces no spans at all.
- [ ] Sanity-check the tree shape in a real trace: `workflow` → `http.process` → `agentic.turn` → …, one level deeper than before this feature.
