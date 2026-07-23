# Monocle for tracing GenAI app code

**Monocle** helps developers and platform engineers building or managing GenAI apps monitor these in prod by making it easy to instrument their code to capture traces that are compliant with open-source cloud-native observability ecosystem. 

**Monocle** is a community-driven OSS framework for tracing GenAI app code governed as a [Linux Foundation AI & Data project](https://lfaidata.foundation/projects/monocle/). 

## Why Monocle

Monocle is built for: 
- **app developers** to trace their app code in any environment without lots of custom code decoration 
- **platform engineers** to instrument apps in prod through wrapping instead of asking app devs to recode
- **GenAI component providers** to add observability features to their products 
- **enterprises** to consume traces from GenAI apps in their existing open-source observability stack

Benefits:
- Monocle provides an implementation + package, not just a spec 
   - No expertise in OpenTelemetry spec required
   - No bespoke implementation of that spec required
   - No last-mile GenAI domain specific code required to instrument your app
- Monocle provides consistency  
   - Connect traces across app code executions, model inference or data retrievals
   - No cleansing of telemetry data across GenAI component providers required
   - Works the same in personal lab dev or org cloud prod environments
   - Send traces to location that fits your scale, budget and observability stack
- Monocle is fully open source and community driven
   - No vendor lock-in
   - Implementation is transparent
   - You can freely use or customize it to fit your needs 

## What Monocle provides

- Easy to [use](#use-monocle) code instrumentation
- OpenTelemetry compatible format for spans. 
- Community-curated and extensible metamodel for consistent tracing of GenAI components. 
- Export to local and cloud storage 

## Use Monocle

Install:

```
npm install --save monocle2ai
```

Monocle instruments GenAI libraries (OpenAI, LangChain, LlamaIndex, Mastra, …) by
hooking them **at module load**, so Monocle must be set up **before your app imports
those libraries**. How you arrange that depends on your runtime.

### Node / tsx scripts

Preload the built-in register entry — no instrumentation file to write:

```
node --import monocle2ai/register app.js
tsx  --import monocle2ai/register app.ts
```

Or set it once in `.env` and launch with `--env-file` (Node reads `NODE_OPTIONS` at
startup, so this preloads before your app graph loads):

```
# .env
NODE_OPTIONS=--import monocle2ai/register
MONOCLE_WORKFLOW_NAME=my-app        # service name used by monocle2ai/register
```
```
node --env-file=.env app.js
```

A plain top-of-file `import` of your setup is **not** enough in ESM: the whole import
graph loads before any code runs, so the instrumented libraries are already loaded by
then. Use the preload above (or `mastra dev` / Next.js integration below).

### Next.js

Two small, standard touches — no `--import`/`NODE_OPTIONS` needed (Next's
instrumentation hook is the preload):

1. `next.config.ts` — wrap with `withMonocle`. A bundler would otherwise inline
   Monocle and the instrumented packages, leaving nothing to hook. `withMonocle`
   keeps them external (it externalizes a curated set of safe backend SDKs by
   default; pass app-specific ones via `externalPackages`):

   ```ts
   import { withMonocle } from "monocle2ai/next";
   export default withMonocle(nextConfig, {
     externalPackages: ["@mastra/core", "@mastra/ai-sdk", "@mastra/loggers"],
   });
   ```

2. `src/instrumentation.ts` — Next runs `register()` before your app; set up Monocle there:

   ```ts
   import { setupMonocle } from "monocle2ai";
   export function register() {
     setupMonocle("my-app");
   }
   ```

### mastra dev

`mastra dev` bundles your app and spawns a server process, forwarding `.env` to it.
Set the preload in `.env` and it reaches the spawned process at startup:

```
# .env
NODE_OPTIONS=--import monocle2ai/register
```

### Hook audit

Under a bundler (Next.js), if an instrumented dependency is installed but never gets
hooked — usually because it was bundled/inlined and can't be traced — Monocle logs a
one-time warning telling you to externalize it. Silence or tune it with
`MONOCLE_DISABLE_HOOK_AUDIT` / `MONOCLE_HOOK_AUDIT_DELAY_MS` / `MONOCLE_FORCE_HOOK_AUDIT`.

### Configuration

See [.env.example](.env.example) for all environment variables — exporters
(console/file/S3/Azure/Okahu), output paths, preload, hook audit, and debug.
## Roadmap 

Goal of Monocle is to support tracing for apps written in *any language* with *any LLM orchestration or agentic framework* and built using models, vectors, agents or other components served up by *any cloud or model inference provider*. 

Current version supports: 
- Language: (🟢) Typescript
- LLM-frameworks: (🟢) Langchain, (🟢) Llamaindex, (🟢) OpenAI, 
- Exporter: (🟢) stdout, (🟢) file, (🟢) Azure Blob Storage, (🟢) AWS S3


## Get involved
### Provide feedback
- Submit issues and enhancements requests via Github issues

### Contribute
- Monocle is community based open source project. We welcome your contributions. Please refer to the CONTRIBUTING and CODE_OF_CONDUCT for guidelines. The contributor's guide provides technical details of the project.

