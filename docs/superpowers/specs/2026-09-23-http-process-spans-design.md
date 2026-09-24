# HTTP process spans for trace return

Status: approved design, not yet implemented
Date: 2026-09-23

## Summary

Emit a real `http.process` span for every incoming request, beneath a
`workflow` span, replacing the bare root span the trace-return hook hand-rolls
today. Each span carries the request's method, route, URL, query params, request
body, status code and response body, and is recognised by the rest of Monocle by
type.

**Amended 2026-09-24:** this was originally scoped to requests served while
trace return was active. It is now general instrumentation — the hook installs
from `setupMonocle` unconditionally, the way every other metamodel does, and
trace return merely registers trailer callbacks on top. See "Relationship to
trace return" for what that changed.

## Why

`SPAN_TYPES.HTTP_PROCESS` and `SPAN_TYPES.HTTP_SEND` have existed in
`src/instrumentation/common/constants.ts` since before this work and are emitted
by nobody. What trace return returns today as its root is a generic `SERVER`
span named `POST /travel_booking` carrying `http.method`, `http.target` and
`http.status_code` — no `span.type`, no `entity.N.*`, no events. A test client
can assert on agents and tools but has nothing to assert at the HTTP boundary,
and the span matches no known shape downstream.

## Scope

### In scope

- One `http.process` span per request, created and owned by the `node:http`
  server hook, beneath a `workflow` span the hook also creates.
- Attribute and event capture through a declarative metamodel, in the same
  style as every other metamodel in the SDK.
- Absorbing `src/traceReturn/requestSpan.ts` into the hook.
- Ending the span when the client aborts mid-response (today it is silently
  lost — see Error handling).
- Installing the hook unconditionally from `setupMonocle`, so HTTP spans are
  produced whether or not trace return is enabled (amended 2026-09-24).
- An excluded-path list, which is what makes unconditional installation safe for
  both noise and secrets.

### Out of scope, and why

- **`http.send` (outbound calls).** Deferred, but no longer indefinitely — see
  "Future direction". Calls that matter today are already traced by their own
  metamodels: a Gemini call is an `inference` span, not an untyped HTTP call.
  `http.send` adds value for requests no metamodel covers, such as
  agent-to-agent or a tool hitting a plain REST API, and it is the missing half
  of end-to-end client/server tracing.
- **Health-check sampling as `monocle_apptrace` does it.** Upstream suppresses
  repeated empty GETs via `HttpSpanHandler.should_sample` and a cyclic counter.
  We suppress by configured path instead — see "Excluded paths". A path list is
  predictable where a heuristic is not, and it skips span creation altogether
  rather than creating a span and discarding it. Also see Open questions: the
  upstream mechanism reads a `data.output` field the maintained metamodels no
  longer emit, so it may not fire upstream either.
- **Request and response headers.** Considered and dropped. They carry
  `authorization`, `cookie` and the trace-return retrieval key, and spans reach
  the normal exporter on every request, so capturing them would route secrets
  somewhere new. `monocle_apptrace` captures no headers either.
- **Per-framework metamodels.** See Architecture: one transport-level hook
  covers every framework, and the framework-specific detail we want is
  reachable by reading properties rather than patching internals.

## Architecture

### Module layout

| Path | Change |
|---|---|
| `src/instrumentation/http/serverHook.ts` | New. The `node:http` patch, moved out of `src/traceReturn/httpHook.ts`. |
| `src/instrumentation/metamodel/http/entities/httpProcess.ts` | New. The declarative attribute and event definitions. |
| `src/traceReturn/httpHook.ts` | Shrinks to the trailer concern: delimiter, `accept-encoding` strip, `Content-Length` drop, span pop, trailer append. |
| `src/traceReturn/requestSpan.ts` | Deleted. Its scope tagging and end-before-pop ordering move into the hook; its `ADD_NEW_WORKFLOW_SYMBOL` handling is dropped — see "Span shape". |
| `src/instrumentation/common/spanHandler.ts` | `attachWorkflowType` writes the resolved workflow type into the hook's holder when one is present. A few lines, a no-op for every existing caller. |

`src/instrumentation/http/` must not import from `src/traceReturn/`. The gate is
the only place the two features meet.

### Request lifecycle

1. `setupMonocle` installs the hook unconditionally. Trace return, when enabled,
   separately registers its trailer callbacks.
2. On the server's `request` event, the raw path with the query stripped is
   checked against `MONOCLE_HTTP_EXCLUDE_PATHS`. A match returns immediately:
   no spans, no response patches, no capture.
3. Extract inbound trace context with
   `propagation.extract(context, req.headers)`, so an incoming `traceparent`
   joins the caller's trace, and re-import any scope headers configured in
   `get_http_scopes()`.
4. Start the `workflow` span as the trace root, then the `http.process` span
   with `SpanKind.SERVER` as its child. See "Span shape" below — this is a
   change from today, where the HTTP span is the root.
5. Run the handler inside the `http.process` span's context.
6. On `res.end`, collect what the frameworks left on `req` and `res`, apply the
   metamodel, end the `http.process` span, resolve the workflow type, end the
   `workflow` span.
7. Trace return, when active, appends its trailer to the same response and pops
   the same trace. It no longer owns a span.

Step 3 activates code that has been dead since it was written: `http_scopes` is
populated by `load_scopes()` in `src/instrumentation/common/utils.ts` and read
by nothing. This is its first consumer.

### Reusing the metamodel machinery

`DefaultSpanHandler.processSpan` is a plain method taking
`{span, instance, args, returnValue, outputProcessor}`. It does not require
going through `wrapper.ts`. The hook therefore calls it directly:

```ts
processSpan({
    span,
    instance: req,
    args: [req] as any,
    returnValue: res,
    outputProcessor: [HTTP_PROCESS],
});
```

That single call sets `span.type`, the `entity.N.*` attributes and the
`data.input` / `data.output` events from the declaration. The metamodel stays
declarative and reads like every other one in the SDK, while the span itself is
owned by a transport hook rather than by a wrapped method.

### Span shape

The hook creates two spans, not one:

```
workflow                 ← trace root, created by the hook
└── http.process         ← SpanKind.SERVER, the handler runs inside this
    └── workflow.adk / agentic.turn / inference ...
```

This matches `monocle_apptrace`, verified against a real upstream trace: its
flask `http.process` span has a `workflow` span as its parent, not as its child.

**It is the reason the entity index comes out right.** `processSpan` starts the
index at 3 for root spans, because 1 and 2 belong to the workflow and hosting
entities. If `http.process` were the root its attributes would land at
`entity.3.method`; as a child of `workflow` they land at `entity.1.method`,
which is what upstream emits and what `HttpSpanHandler.should_sample` reads.

**`ADD_NEW_WORKFLOW_SYMBOL` is no longer set by the hook.** It exists to make
the first instrumented call insert a `workflow` span when one is missing; the
hook now provides that span itself, and setting the flag as well would produce
two. Nothing else is needed to suppress the injection: the first wrapped call
runs with `http.process` as its parent, so `isRootSpan` is false and
`shouldAddWorkflowSpan` is already false.

### Resolving the workflow type

The hook must create the `workflow` span before any framework code has run, so
at creation time it cannot know whether this is `workflow.adk`,
`workflow.langchain` or `workflow.generic`. The type is therefore set at the
end, while the span is still open and mutable.

`wrapper.ts` calls `attachWorkflowType(element)` on every wrapped call, which
resolves the framework type and stores it in the OTel context. Context is
immutable and scoped, so a value set deep inside the handler is invisible to the
hook at `res.end`. The hook therefore places a small mutable holder in the
context at request start, under a module-private `Symbol`; `attachWorkflowType`
writes the resolved type into it the first time it upgrades away from generic.

At `res.end` the hook reads the holder, defaulting to `WORKFLOW_TYPE_GENERIC`
when nothing wrote to it, and sets `entity.1.name`, `entity.1.type` and the
hosting entity on the workflow span before ending it.

This is the one change outside `src/instrumentation/http/`: a few lines in
`attachWorkflowType`, writing to the holder when present. It is a no-op for
every existing caller.

### Relationship to trace return

**Amended 2026-09-24.** The hook is no longer gated on trace return.
`setupMonocle` installs it unconditionally, exactly as it installs every other
metamodel — nobody opts into langchain instrumentation either, and HTTP spans
are ordinary spans exported through the ordinary pipeline. There is no new
environment variable and no interaction between two gates to reason about.

Trace return becomes a consumer of the hook rather than its owner: when enabled,
it registers `{onRequestStart, scopesFor, onBeforeEnd}` callbacks. When disabled,
nothing registers and the hook still produces spans.

Two per-request decisions stay distinct, and conflating them is a memory bug:

| Condition | Effect |
|---|---|
| Always (path not excluded) | The request gets a `workflow` + `http.process` pair, exported normally. |
| Request also carries a valid retrieval key | The spans are additionally tagged with the `monocle_trace_return` scope, and the trailer is appended to the response. |

The span is unconditional because creating one leaks nothing — it goes to the
application's own exporter, like every other span. The **scope tag must stay
gated on authorization**, because `TraceReturnSpanExporter.export` buffers every
span carrying that scope until a response pops it. Under the original
trace-return-only gate a leak here was bounded by test traffic; now every
production request flows through this code, so tagging unauthorized requests
would grow that buffer without bound.

The invariant that made this amendment a one-line change, and which must hold:
**the span-producing code knows nothing about trace return.**
`src/instrumentation/http/` does not import from `src/traceReturn/`; the
dependency is inverted through `registerHttpRequestHooks`.

### What flipping the gate changed

Three consequences, all of them now real rather than hypothetical:

**Every existing user's trace tree gains a level.** An instrumented Express app
serving an agent emitted `workflow → agentic.turn → …`; it now emits
`workflow → http.process → agentic.turn → …`, and the `workflow` span comes from
the hook rather than from `wrapper.ts`. Assertions keyed on span type or name
survive. Anything keyed on tree depth does not.

**Span-name cardinality is handled.** The name is recomputed in `finish()` and
applied with `span.updateName()` once the framework has populated `req.route`,
so a parameterised route is named `GET /users/:id` and not `GET /users/12345`.
Without this, production span names would be unbounded.

**Request bodies now reach production traces.** A login endpoint's body contains
its password. The decision (2026-09-24) is to capture everything and rely on the
excluded-path list to keep sensitive routes out, rather than to redact or to
default the capture off.

### Excluded paths

`MONOCLE_HTTP_EXCLUDE_PATHS` holds a comma-separated list of path prefixes. A
request whose path matches one is served with no hook involvement at all: no
spans are started, no response patches are installed, and no capture happens.
Exclusion is checked before anything else, on the raw path with the query
stripped, because the route template is not yet known at that point.

It serves two purposes at once:

- **Noise.** A liveness probe on `/health` every second is ~86,400 spans a day
  of pure noise. Skipping span creation entirely is cheaper than creating and
  discarding, and a configured list is predictable where a heuristic is not.
- **Secrets.** An endpoint that receives credentials can be excluded, which is
  what makes "capture bodies without redaction" a defensible default.

Matching is prefix-based rather than exact so that `/health` covers
`/health/ready`. Empty or unset means nothing is excluded.

## The span

### Naming

`GET /users/:id` when the route template is known, `GET /users/12345` when it is
not. `monocle_apptrace` uses a static `"fastapi.request"`, which avoids
high-cardinality span names; cardinality is a production concern and this runs
only under trace return, so the readable name wins.

### Attributes

| Location | Attribute | Source |
|---|---|---|
| entity | `method` | `req.method` |
| entity | `route` | `req.baseUrl + req.route.path`, else the raw path |
| entity | `url` | scheme, `req.headers.host`, `req.url` |
| `data.input` | `params` | the raw query string from `req.url`, e.g. `lang=en&verbose=true` |
| `data.input` | `request_body` | `req.body` when a body parser ran |
| `data.output` | `status_code` | `String(res.statusCode)` — a string, not a number |
| `data.output` | `response` | captured response body |

**Accessor inputs.** `processSpan` passes *different* shapes to the two kinds of
accessor: entity attributes receive `{instance, args, output, parentSpan}`,
while event attributes receive `{args, response, instance, exception}`. The
`ServerResponse` is therefore `output` in an entity accessor and `response` in an
event accessor; `instance` is the `IncomingMessage` in both. Getting this wrong
yields a silently empty attribute, not an error. Values that must be
computed rather than read — the captured response body, and the query params
parsed from `req.url` — are stashed on the response under a module-private
`Symbol` by the capture code, and the accessors read them from there. Accessors
stay pure property reads; nothing in the metamodel parses or buffers.

**Scheme for `url`** comes from `req.socket.encrypted`, falling back to
`x-forwarded-proto` when present, then `http`.

No `entity.N.type` is set. None of the upstream HTTP metamodels set one either,
unlike most other entity types. Noted rather than invented.

Duration needs no attribute: every span carries start and end times. A
`duration_ms` would be a second source of truth that can disagree with the
first.

### Divergences from monocle_apptrace

The upstream HTTP metamodels do not agree with each other. The survey is in the
appendix. Three choices follow from it:

1. **`status_code`, not `error_code`.** Upstream PR #644 (2026-06-27) is titled
   "Enhance request body collection for Flask instrumentation and rename
   error_code to status_code for http spans". `error_code` is legacy that was
   not migrated in the aiohttp, lambdafunc and agentcore metamodels, none of
   which has been touched since. The three actively maintained ones all say
   `status_code`.
2. **The request body is an event attribute, never an entity attribute.** The
   aiohttp and lambdafunc metamodels put `body` in the entity attributes;
   fastapi, flask and azfunc put `request_body` in `data.input`. We follow the
   maintained majority.
3. **No `function_name`.** It exists only in the serverless metamodels and has
   no Express equivalent.

Net result: the attribute set is identical to the fastapi metamodel's.

Three deliberate divergences remain, all in span shape rather than attributes:

| | upstream | here | why |
|---|---|---|---|
| `kind` | `INTERNAL` | `SERVER` | Upstream's span comes from a wrapped method, so `INTERNAL` is incidental rather than chosen. This is genuinely a server span, and Monocle keys off `span.type`, so being correct costs nothing. |
| span name | `flask.app.Flask.wsgi_app` | `POST /api/v1/ask` | Upstream names the span after the wrapped method. We have no wrapped method, and the route is more useful. |
| `http.method`, `http.status_code`, `http.target` | absent | absent | Today's trace-return root span sets these OpenTelemetry-convention attributes. They duplicate `entity.1.*`, so they are dropped. |

## Capture rules

### Request body

Read `req.body`. Do not touch the request stream.

`req` is a consume-once `Readable`, with exactly the trap the upstream flask
helper warns about — reading `wsgi.input` for instrumentation steals the body
from the view and produces 400s, so upstream reads it once in the wrapper and
re-injects it. We do not need to: by the time our `res.end` patch runs,
`express.json()` has already parsed the body and left it on `req.body`. We read
a property.

The cost is that an application with no body parser — a raw
`http.createServer`, or a route consuming the stream itself — yields no body.
That degrades to an empty attribute, never to a broken request.

**We will not tee the request stream.** If raw-stream capture is ever needed it
is a separate decision with its own risk budget, not an incremental change.

### Response body

Accumulate a capped copy inside the existing `res.write` and `res.end` patches.

This is copy-and-forward, not buffer-and-forward: no chunk is ever delayed, so
streaming and SSE behave exactly as they do today. Upstream needed a dedicated
`_monocle_streaming_state` machine for the equivalent; we get it from where the
hook already sits.

### Params and route

`params` is the raw query string from `req.url`, emitted as-is. It is not
parsed into an object and not merged with route params: a real upstream trace
emits `"lang=en&verbose=true"`. `route` is `req.baseUrl + req.route.path` when
Express-shaped, otherwise the raw path with the query stripped — the same
fallback the span name uses.

### Size caps and value shapes

`MAX_DATA_LENGTH = 1000` characters and `MAX_STREAMING_CAPTURE_LENGTH = 5000`,
matching upstream. TypeScript has no equivalent constant today, so this
introduces a shared one.

`req.body` may be an object, a string or a `Buffer`. Stringify, decode,
truncate, in that order, and never throw.

### Accepted property

The request body is captured without redaction, so a login endpoint's body
lands in the span with its password — and since 2026-09-24 that reaches
production traces, not only test-mode ones. Upstream caps but does not redact,
and the decision here is to match it and rely on `MONOCLE_HTTP_EXCLUDE_PATHS` to
keep sensitive routes out of tracing entirely.

That puts the burden on configuration rather than on the default, so it belongs
in user-facing documentation, not only here. An operator who never sets the
variable gets credentials in their traces.

## Error handling

A tracing feature must never take a request down. That rule already governs
`src/traceReturn/httpHook.ts` and extends to every new step: body read, route
extraction and `processSpan` are individually guarded, so one bad attribute
costs that attribute and not the span. `processSpan` already catches per
accessor, which gives that for free inside the metamodel.

**A throwing handler is invisible to us.** The hook patches `Server.emit`, so
the framework's error middleware handles the exception long before it could
reach us. Status is inferred from `res.statusCode`, as the code does today. This
is why `recordException` is not called.

**Client aborts end the span.** If the client disconnects mid-response,
`res.end` may never be called, so today the span never ends, `SimpleSpanProcessor`
never exports it, and the request vanishes from the trace with no indication
why. Nothing leaks — the child spans sit in the buffer until `MAX_PENDING_TRACES`
evicts them — but the information is gone. Add `res.on("close")` as a backstop
that ends the span with an aborted status.

This is a pre-existing trace-return defect, not one this feature introduces. It
is in scope because this work rewrites the exact path that contains it.

**Double `res.end`** stays idempotent via the existing `finished` flag.

## Testing

**Unit, no server.** Metamodel accessors against synthetic `req` and `res`
objects: body shapes (object, string, `Buffer`, absent), truncation at 1000 and
5000, route fallback when `req.route` is missing, params merging. This is where
the attribute names get pinned, so that a future rename breaks a test instead of
silently emptying an attribute — the lesson from `Inputs` versus `input`.

**Unit, real server.** A plain `http.createServer` on an ephemeral port covers
the no-framework fallback. A real Express app covers the duck-typed path,
asserting that `req.route.path` and `req.body` are populated at the moment our
`res.end` patch runs. That assumption is load-bearing for the whole design and
deserves a test that fails if Express changes it. `express` and
`@types/express` are already devDependencies.

**Integration.** Coverage may go in `test/integration/adk.test.ts` once the open
PR fixing the default-exporter change (file versus console) has landed. That is
an ordering dependency, not a prohibition.

**Real validation.** The ADK demo application asserts the `http.process` span
from its pytest client, consistent with the decision that real validation lives
there rather than in this repo.

## Future direction

Recorded 2026-09-24 so the work here stays pointed the right way. Not in scope,
not designed, not committed to.

The intent is for the client to start the trace when it initiates a request,
propagate the trace id and whatever else is needed over headers, have the server
continue that same trace, and conclude it when the request completes.

**The server half of that already exists in this design.** Step 3 of the request
lifecycle calls `propagation.extract(context, req.headers)`, so a request
arriving with a `traceparent` continues the caller's trace rather than starting
a new one, and configured scope headers are re-imported with it. A server built
to this spec will join a client's trace on day one.

What is missing is the client half: an `http.send` span around outbound calls
that injects `traceparent` — plus, to match `monocle_apptrace`, a `tracestate`
carrying the SDK version via `add_monocle_trace_state`, and a URL allowlist
(upstream spells its variable `MONOCLE_TRACE_PROPAGATATION_URLS`, typo included)
so that arbitrary third-party calls are not traced by default.

Two things worth settling before that work starts, neither of which this spec
answers: whether outbound instrumentation hooks `fetch`, `node:http.request`,
`axios`, or some combination; and whether the allowlist should default to
tracing nothing, as upstream does, or to tracing everything.

## Open questions

1. **Which attribute names does the Okahu ingestion backend actually read?**
   `monocle_test_tools` has no HTTP span support at all — `HttpRunner` is
   transport only — so unlike trace return, where the client pinned every
   constant, there is no client-side contract to check against. The names here
   are chosen from upstream evidence, not confirmed against a consumer.

   **Deferred by decision, 2026-09-23:** resolve this during testing rather than
   before implementation. The names are pinned by unit tests, so changing one
   later is a rename plus a test update, not a redesign.
2. **Upstream health-check sampling reads a field that is no longer emitted.**
   `HttpSpanHandler.should_sample` reads `error_code` from `data.output`, which
   the fastapi, flask and azfunc metamodels stopped emitting in PR #644. Its
   read of `entity.1.method` is correct, because the HTTP span is a child of the
   `workflow` span rather than the trace root — confirmed against a real
   upstream trace. Not blocking, since we are not porting the mechanism, but
   worth reporting upstream.

## Appendix: upstream naming survey

Seven metamodels in `monocle_apptrace`, no two agreeing:

| metamodel | type | entity attrs | `data.input` | `data.output` |
|---|---|---|---|---|
| fastapi | `http.process` | method, route, url | params, request_body | status_code, response |
| flask | `http.process` | method, route, url | request_body, params | status_code, response |
| aiohttp | `http.process` | method, route, url, function_name, body | params | error_code, response |
| azfunc | `http.process` | method, route, function_name, url | request_body, params | status_code, response |
| lambdafunc | `http.process` | method, route, body, url | params | error_code, response |
| agentcore | `http.process` | route, method | request | error_code, response |
| requests | `http.send` | method, URL | http.params, body | status, response |

Three spellings for the status field, `url` versus `URL`, `request_body` versus
`body` versus `request`, `params` versus `http.params`, and the body sometimes
an entity attribute and sometimes an event attribute.

There is no specification upstream to resolve this. `docs/` covers design,
scopes, the trace API, test assertions, trace loading and evaluation, and says
nothing about HTTP spans; `Monocle_supported_patterns.md` does not mention them;
`MONOCLE_TRACE_PROPAGATATION_URLS` and `MONOCLE_SAMPLE_HEALTH_CHECKS` are
documented nowhere but their own source. The three
`test_*_tracid_propogation.py` integration tests are the entire contract.
