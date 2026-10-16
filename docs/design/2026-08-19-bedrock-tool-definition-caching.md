# Tool-Definition Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a caller mark a tool as the end of the cacheable prefix of a Converse tool list, so `@effect/ai-amazon-bedrock` emits a `cachePoint` entry after that tool's `toolSpec`.

**Architecture:** The Converse `Tool` union gains its `cachePoint` member in `AmazonBedrockSchema.ts` (all-members-optional struct, the convention already used for `ContentBlock`). `AmazonBedrockLanguageModel.ts` exports a `Context.Reference` tool annotation, `ToolCachePoint`, read per tool in `prepareTools`; each annotated tool's `{ toolSpec }` entry is followed by a `{ cachePoint }` entry. Cache points travel with the tool they follow through `toolChoice: { oneOf }` filtering, and the "send `toolConfig` at all" guard counts tool specs rather than array entries.

**Tech Stack:** TypeScript, Effect 4 (`effect/Schema`, `effect/Context`, `effect/unstable/ai`), `@effect/vitest`, changesets.

**Spec:** `docs/superpowers/specs/2026-08-19-bedrock-tool-definition-caching-design.md`

## Global Constraints

- Worktree root is `/home/mrwe1@office.begasoft.ch/projects/effect-ts/effect/.worktrees/feat-ai-amazon-bedrock`. Every command below runs from there.
- TDD is mandatory: no production edit before a test that fails for the right reason.
- Public exports carry JSDoc with `@category` and `@since 4.0.0`. Package `docgen` fails otherwise.
- Follow the file's existing idioms: `Effect.fnUntraced`, `Predicate.isNotUndefined`, `Schema.optional` for union members.
- In `AmazonBedrockLanguageModel.ts`, the identifier `Tool` is `effect/unstable/ai/Tool`. The Converse tool schema is imported as a type from `./AmazonBedrockSchema.ts` and must be referenced under a distinct alias.
- The Converse `tools` array has `length.min = 1`; a request whose tool list holds only cache points is invalid.
- Test command: `pnpm vitest --run packages/ai/amazon-bedrock/test`
- Full check: `pnpm check` (types) and `pnpm lint-fix`.

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/ai/amazon-bedrock/src/AmazonBedrockSchema.ts` | Wire schemas for Converse | `Tool` becomes union-shaped: optional `toolSpec`, optional `cachePoint` |
| `packages/ai/amazon-bedrock/src/AmazonBedrockLanguageModel.ts` | Prompt/tool encoding and response decoding | Export `ToolCachePoint`; `prepareTools` emits cache points |
| `packages/ai/amazon-bedrock/test/AmazonBedrockSchema.test.ts` | Schema round-trip tests | Adapt existing `Tool` test to optional `toolSpec`; add a cache-point entry test |
| `packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts` | Request-capture behaviour tests | Add three tests in the tool-calling describe block |
| `TODO.md` | Deferred-capability log | Drop the `## Tool-definition caching` section; record `systemTool` as unmodelled by design |
| `.changeset/amazon-bedrock-tool-definition-caching.md` | Release note | New file |

---

### Task 1: Model `cachePoint` in the Converse `Tool` union

**Files:**
- Modify: `packages/ai/amazon-bedrock/src/AmazonBedrockSchema.ts:389-396`
- Test: `packages/ai/amazon-bedrock/test/AmazonBedrockSchema.test.ts:35-56`

**Interfaces:**
- Consumes: `CachePointBlock` (already defined at `AmazonBedrockSchema.ts:145`), `ToolSpecification` (line 380).
- Produces: `AmazonBedrockSchema.Tool` with encoded type `{ readonly toolSpec?: { name: string; description?: string; inputSchema: { json: Record<string, unknown> } } | undefined; readonly cachePoint?: { type: "default"; ttl?: "5m" | "1h" } | undefined }`. Task 2 and Task 3 push both shapes into `ToolConfiguration.tools`.

- [ ] **Step 1: Write the failing test**

Append inside the existing top-level `describe` in `packages/ai/amazon-bedrock/test/AmazonBedrockSchema.test.ts` (after the `"encodes a ConverseRequest carrying toolConfig"` test):

```ts
  it.effect("encodes a cachePoint entry in toolConfig.tools", () =>
    Effect.gen(function*() {
      const encoded = yield* Schema.encodeEffect(AmazonBedrockSchema.ConverseRequest)(
        new AmazonBedrockSchema.ConverseRequest({
          modelId: "m",
          messages: [],
          toolConfig: new AmazonBedrockSchema.ToolConfiguration({
            tools: [
              new AmazonBedrockSchema.Tool({
                toolSpec: new AmazonBedrockSchema.ToolSpecification({
                  name: "GlobTool",
                  inputSchema: { json: { type: "object" } }
                })
              }),
              new AmazonBedrockSchema.Tool({
                cachePoint: new AmazonBedrockSchema.CachePointBlock({ type: "default", ttl: "1h" })
              })
            ]
          })
        })
      )
      assert.deepStrictEqual(encoded.toolConfig?.tools[1], { cachePoint: { type: "default", ttl: "1h" } })
    }))
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest --run packages/ai/amazon-bedrock/test/AmazonBedrockSchema.test.ts`

Expected: a type error / failure on the second `new AmazonBedrockSchema.Tool({ cachePoint: ... })` — `Tool` has no `cachePoint` member and `toolSpec` is required.

- [ ] **Step 3: Make the union members optional**

In `packages/ai/amazon-bedrock/src/AmazonBedrockSchema.ts`, replace the `Tool` class and its doc comment with:

```ts
/**
 * A tool entry within a {@link ToolConfiguration}.
 *
 * **Details**
 *
 * Converse models this as a union: an entry is either a `toolSpec` describing a
 * callable tool, or a `cachePoint` marking the end of the cacheable prefix of
 * the tool list. Like every AWS union in this module, it is modelled as a
 * struct whose members are all optional.
 *
 * The union's third member, `systemTool`, selects a Bedrock-hosted tool this
 * provider cannot invoke, and is not modelled.
 *
 * @category schemas
 * @since 4.0.0
 */
export class Tool extends Schema.Class<Tool>(makeIdentifier("Tool"))({
  toolSpec: Schema.optional(ToolSpecification),
  cachePoint: Schema.optional(CachePointBlock)
}) {}
```

- [ ] **Step 4: Fix the now-optional access in the existing schema test**

`toolSpec` is optional, so the existing assertion no longer type-checks. In `packages/ai/amazon-bedrock/test/AmazonBedrockSchema.test.ts`, change:

```ts
      assert.strictEqual(encoded.toolConfig?.tools[0]?.toolSpec.name, "GlobTool")
```

to:

```ts
      assert.strictEqual(encoded.toolConfig?.tools[0]?.toolSpec?.name, "GlobTool")
```

- [ ] **Step 5: Run the tests and the type check**

Run: `pnpm vitest --run packages/ai/amazon-bedrock/test/AmazonBedrockSchema.test.ts`
Expected: PASS.

Run: `pnpm check`
Expected: clean. If `prepareTools` in `AmazonBedrockLanguageModel.ts` now errors on `t.toolSpec.name` (the `oneOf` filter), leave it — Task 3 rewrites that line. If you need `pnpm check` green before then, do Tasks 2 and 3 before committing this one.

- [ ] **Step 6: Commit**

```bash
git add packages/ai/amazon-bedrock/src/AmazonBedrockSchema.ts packages/ai/amazon-bedrock/test/AmazonBedrockSchema.test.ts
git commit -m "feat(amazon-bedrock): model the cachePoint member of the Converse Tool union"
```

---

### Task 2: Emit a cache point after an annotated tool

**Files:**
- Modify: `packages/ai/amazon-bedrock/src/AmazonBedrockLanguageModel.ts` (imports at 41-56; new export near the Prompt Caching section around line 84; `prepareTools` at 870-928)
- Test: `packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts` (tool-calling describe block, near line 553)

**Interfaces:**
- Consumes: `AmazonBedrockSchema.Tool` from Task 1; the existing `export type CachePoint = typeof CachePointBlock.Encoded` (line 84); `Tool.Any` and `tool.annotations` from `effect/unstable/ai/Tool`.
- Produces:
  - `export const ToolCachePoint: Context.Reference<CachePoint | undefined>` on `AmazonBedrockLanguageModel`, attached with `tool.annotate(AmazonBedrockLanguageModel.ToolCachePoint, { type: "default" })`.
  - `const getToolCachePoint = (tool: Tool.Any): CachePoint | undefined`.
  - `prepareTools` keeps its existing signature: `(options: LanguageModel.ProviderOptions) => Effect.Effect<{ toolConfig: typeof ToolConfiguration.Encoded | undefined; nameMapper: Tool.NameMapper<ReadonlyArray<Tool.Any>> }, AiError.AiError>`.

- [ ] **Step 1: Write the failing test**

In `packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts`, inside the tool-calling `describe` that defines `GlobTool` / `globToolkit` / `twoToolkit`, add a cached toolkit next to the existing fixtures:

```ts
    const CachedGlobTool = GlobTool.annotate(AmazonBedrockLanguageModel.ToolCachePoint, { type: "default" })
    const cachedToolkit = Toolkit.make(CachedGlobTool, GrepTool)
    const cachedToolkitLayer = cachedToolkit.toLayer({
      GlobTool: () => Effect.succeed("found.ts"),
      GrepTool: () => Effect.succeed("match")
    })
```

Then add the test:

```ts
    it.effect("emits a cachePoint entry after an annotated tool only", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(toolResponse(request, [{ text: "ok" }]))
        }

        yield* LanguageModel.generateText({ prompt: "x", toolkit: cachedToolkit }).pipe(
          Effect.provide(layersFor(handler)),
          Effect.provide(cachedToolkitLayer)
        )

        const body = yield* getRequestBody(captured!)
        assert.strictEqual(body.toolConfig.tools.length, 3)
        assert.strictEqual(body.toolConfig.tools[0].toolSpec.name, "GlobTool")
        assert.deepStrictEqual(body.toolConfig.tools[1], { cachePoint: { type: "default" } })
        assert.strictEqual(body.toolConfig.tools[2].toolSpec.name, "GrepTool")
        assert.isUndefined(body.toolConfig.tools[2].cachePoint)
      }))
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest --run packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts -t "cachePoint entry after an annotated tool"`

Expected: FAIL — `AmazonBedrockLanguageModel.ToolCachePoint` does not exist (compile error), and once it does, `tools.length` is 2 rather than 3.

- [ ] **Step 3: Export the annotation**

In `packages/ai/amazon-bedrock/src/AmazonBedrockLanguageModel.ts`, in the `Prompt Caching` section immediately after the `CachePoint` type alias (line 84), add:

```ts
/**
 * Marks a tool as the end of the cacheable prefix of the tool list.
 *
 * **Details**
 *
 * Converse caches everything preceding a cache point, so annotating a tool
 * caches that tool and every tool declared before it. Annotate the last tool to
 * cache the whole list, or the last stable one and declare volatile tools after
 * it. Omitting `ttl` leaves the cache lifetime to Bedrock.
 *
 * **Example**
 *
 * ```ts
 * import { AmazonBedrockLanguageModel } from "@effect/ai-amazon-bedrock"
 * import { Schema } from "effect"
 * import { Tool } from "effect/unstable/ai"
 *
 * const search = Tool.make("search", {
 *   parameters: Schema.Struct({ query: Schema.String })
 * }).annotate(AmazonBedrockLanguageModel.ToolCachePoint, { type: "default" })
 * ```
 *
 * @category services
 * @since 4.0.0
 */
export const ToolCachePoint = Context.Reference<CachePoint | undefined>(
  "@effect/ai-amazon-bedrock/AmazonBedrockLanguageModel/ToolCachePoint",
  { defaultValue: () => undefined }
)

/**
 * Reads the cache point a tool requests, if any.
 */
const getToolCachePoint = (tool: Tool.Any): CachePoint | undefined => Context.get(tool.annotations, ToolCachePoint)
```

`Context` is already imported (line 21) and `Tool` at line 38, so no import changes are needed here.

- [ ] **Step 4: Add the Converse `Tool` type import**

The encoder needs the entry type. In the type-only import block from `./AmazonBedrockSchema.ts` (lines 41-56), add an aliased member so it does not collide with `effect/unstable/ai/Tool`:

```ts
  SystemContentBlock,
  Tool as BedrockTool,
  ToolChoice,
  ToolConfiguration
} from "./AmazonBedrockSchema.ts"
```

Keep the block alphabetically ordered as it is today (`Tool` sorts after `SystemContentBlock`).

- [ ] **Step 5: Emit the cache point in `prepareTools`**

In `prepareTools`, replace the tool-collection loop. The current code is:

```ts
  const tools: Array<(typeof ToolConfiguration.Encoded)["tools"][number]> = []
  for (const tool of options.tools) {
    ...
    tools.push({
      toolSpec: {
        name: tool.name,
        ...(Predicate.isNotUndefined(description) ? { description } : undefined),
        inputSchema: { json: json as Record<string, unknown> }
      }
    })
  }
```

Replace it with an intermediate list that keeps each tool spec together with the cache point it requests:

```ts
  const entries: Array<{
    readonly toolSpec: NonNullable<(typeof BedrockTool.Encoded)["toolSpec"]>
    readonly cachePoint: CachePoint | undefined
  }> = []
  for (const tool of options.tools) {
    if (!Tool.isUserDefined(tool)) {
      const toolName = (tool as { name: string }).name
      return yield* AiError.make({
        module: "AmazonBedrockLanguageModel",
        method: "prepareTools",
        reason: new AiError.InvalidUserInputError({
          description: `Unsupported tool '${toolName}' - this provider supports user-defined tools only`
        })
      })
    }
    const description = Tool.getDescription(tool)
    const json = yield* tryToolJsonSchema(tool, "prepareTools")
    entries.push({
      toolSpec: {
        name: tool.name,
        ...(Predicate.isNotUndefined(description) ? { description } : undefined),
        inputSchema: { json: json as Record<string, unknown> }
      },
      cachePoint: getToolCachePoint(tool)
    })
  }
```

Then, directly after that loop, flatten the entries into the wire array:

```ts
  // Converse models the tool list as a union of `toolSpec` and `cachePoint`
  // entries, and caches everything preceding a cache point, so a tool's cache
  // point is emitted as its own entry directly after it.
  const tools: Array<typeof BedrockTool.Encoded> = []
  for (const entry of entries) {
    tools.push({ toolSpec: entry.toolSpec })
    if (Predicate.isNotUndefined(entry.cachePoint)) {
      tools.push({ cachePoint: entry.cachePoint })
    }
  }
```

`toolSpec` is optional now, so the `oneOf` filter no longer compiles as written. Make the smallest
change that restores it — cache-point entries have no `toolSpec` to match on:

```ts
    const allowed = new Set(choice.oneOf)
    const filtered = tools.filter((t) => t.toolSpec === undefined || allowed.has(t.toolSpec.name))
    tools.length = 0
    tools.push(...filtered)
```

The final `tools.length > 0` guard stays as it is. Both of these are wrong in ways Task 3 exposes
with tests; do not fix them ahead of it.

- [ ] **Step 6: Run the test and watch it pass**

Run: `pnpm vitest --run packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts`
Expected: PASS, including every pre-existing tool test.

- [ ] **Step 7: Write the `ttl` test**

```ts
    it.effect("carries the cache point ttl into the request", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(toolResponse(request, [{ text: "ok" }]))
        }

        const ttlTool = GlobTool.annotate(AmazonBedrockLanguageModel.ToolCachePoint, { type: "default", ttl: "1h" })
        const ttlToolkit = Toolkit.make(ttlTool)

        yield* LanguageModel.generateText({ prompt: "x", toolkit: ttlToolkit }).pipe(
          Effect.provide(layersFor(handler)),
          Effect.provide(ttlToolkit.toLayer({ GlobTool: () => Effect.succeed("found.ts") }))
        )

        const body = yield* getRequestBody(captured!)
        assert.deepStrictEqual(body.toolConfig.tools[1], { cachePoint: { type: "default", ttl: "1h" } })
      }))
```

- [ ] **Step 8: Run it**

Run: `pnpm vitest --run packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts -t "ttl into the request"`
Expected: PASS immediately — the annotation value is passed through verbatim, so this test guards the pass-through rather than driving new code. If it fails, the encoder is dropping or rewriting the annotation value; fix that.

- [ ] **Step 9: Commit**

```bash
git add packages/ai/amazon-bedrock/src/AmazonBedrockLanguageModel.ts packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts
git commit -m "feat(amazon-bedrock): cache tool definitions via a per-tool annotation"
```

---

### Task 3: Keep cache points with their tool through filtering, and guard the empty list

**Files:**
- Modify: `packages/ai/amazon-bedrock/src/AmazonBedrockLanguageModel.ts` (`prepareTools`, the `oneOf` branch and the `toolConfig` guard)
- Test: `packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts` (tool-calling describe block)

**Interfaces:**
- Consumes: the `entries` array and `getToolCachePoint` from Task 2.
- Produces: no new exports. `prepareTools` returns `toolConfig: undefined` whenever no `toolSpec` entry survives filtering.

- [ ] **Step 1: Write the failing test**

The annotated tool is `GlobTool`; a `oneOf` that selects only `GrepTool` must drop `GlobTool` *and* its cache point, leaving one entry rather than two.

```ts
    it.effect("drops a filtered-out tool's cache point with the tool", () =>
      Effect.gen(function*() {
        let captured: HttpClientRequest.HttpClientRequest | undefined = undefined
        const handler = (request: HttpClientRequest.HttpClientRequest) => {
          captured = request
          return Effect.succeed(toolResponse(request, [{ text: "ok" }]))
        }

        yield* LanguageModel.generateText({
          prompt: "x",
          toolkit: cachedToolkit,
          toolChoice: { oneOf: ["GrepTool"] }
        }).pipe(
          Effect.provide(layersFor(handler)),
          Effect.provide(cachedToolkitLayer)
        )

        const body = yield* getRequestBody(captured!)
        assert.strictEqual(body.toolConfig.tools.length, 1)
        assert.strictEqual(body.toolConfig.tools[0].toolSpec.name, "GrepTool")
      }))
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest --run packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts -t "drops a filtered-out tool"`

Expected: FAIL with `tools.length` of 2 — Task 2's filter matches on `toolSpec` only, so it drops `GlobTool` but keeps its cache point, which now sits in front of `GrepTool` and caches nothing.

- [ ] **Step 3: Filter whole entries, then flatten, and count tool specs in the guard**

Two changes in `prepareTools`.

First, move the flattening loop that builds `tools` from directly after the collection loop to
**after** the `toolChoice` block, so filtering happens on `entries` before any cache point is
emitted. The loop body is unchanged.

Second, rewrite the `oneOf` branch to filter each tool together with its cache point, and change
the final guard to count entries:

```ts
    const allowed = new Set(choice.oneOf)
    const filtered = entries.filter((e) => allowed.has(e.toolSpec.name))
    entries.length = 0
    entries.push(...filtered)
```

```ts
  // Bedrock's Converse API rejects an empty `tools` array alongside a
  // `toolChoice`, and a lone cache point covers nothing, so when tool selection
  // filters every tool out (e.g. an `oneOf` that matches no tools) we omit
  // `toolConfig` entirely.
  const toolConfig: typeof ToolConfiguration.Encoded | undefined = entries.length > 0
    ? { tools, ...(Predicate.isNotUndefined(toolChoice) ? { toolChoice } : undefined) }
    : undefined
```

Resulting order inside `prepareTools`: collect `entries` → compute `toolChoice` (filtering `entries`
in the `oneOf` branch) → flatten `entries` into `tools` → assemble `toolConfig` guarded on
`entries.length`.

- [ ] **Step 4: Run the whole package test suite**

Run: `pnpm vitest --run packages/ai/amazon-bedrock/test`
Expected: PASS, all files. Pay attention to the pre-existing `"filters tools to the oneOf set and defaults to auto"` and `"omits toolConfig when toolChoice is 'none'"` tests — they cover the untouched paths.

- [ ] **Step 5: Type-check and lint**

Run: `pnpm check`
Expected: clean.

Run: `pnpm lint-fix`
Expected: clean (it may reformat; re-run the tests if it changes source).

- [ ] **Step 6: Commit**

```bash
git add packages/ai/amazon-bedrock/src/AmazonBedrockLanguageModel.ts packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts
git commit -m "fix(amazon-bedrock): keep a tool's cache point with the tool when filtering"
```

---

### Task 4: Documentation, TODO cleanup and changeset

**Files:**
- Modify: `TODO.md:7-12` and `TODO.md:35-38`
- Create: `.changeset/amazon-bedrock-tool-definition-caching.md`

**Interfaces:**
- Consumes: the exported `ToolCachePoint` from Task 2.
- Produces: nothing consumed by later tasks; this is the final task.

- [ ] **Step 1: Run docgen for the package**

```bash
cd packages/ai/amazon-bedrock && pnpm docgen
```

Expected: PASS. It compiles the JSDoc example on `ToolCachePoint`, so a wrong import path or a stale API in that snippet fails here. Fix the example, not the docgen config. Return to the worktree root afterwards.

- [ ] **Step 2: Remove the resolved TODO section**

Delete lines 7-12 of `TODO.md` — the whole `## Tool-definition caching` section including its heading and trailing blank line. Its premise ("`Toolkit` has no per-tool provider options") was wrong: `Tool` carries `Context.Reference` annotations, which is the surface this work used.

- [ ] **Step 3: Record `systemTool` as unmodelled by design**

In the trailing paragraph of `TODO.md` (currently lines 35-38), append a sentence after the existing `CitationLocation` sentence:

```markdown
The `systemTool` member of the `Tool` union is likewise unmodelled: it selects Bedrock-hosted tools
this provider cannot invoke.
```

- [ ] **Step 4: Write the changeset**

```bash
cat > .changeset/amazon-bedrock-tool-definition-caching.md <<'EOF'
---
"@effect/ai-amazon-bedrock": minor
---

Add tool-definition caching to the Amazon Bedrock provider.

- Mark a tool as the end of the cacheable prefix of the tool list by annotating it:
  `Tool.make("search", { ... }).annotate(AmazonBedrockLanguageModel.ToolCachePoint, { type: "default" })`.
  As with message and part cache points, Converse caches everything preceding the cache point, so
  annotating the last tool caches the whole list, and annotating the last stable tool caches only
  the tools declared up to it. `ttl` is optional and behaves as it does elsewhere.
- The Converse `Tool` union is now modelled with both of its supported members, `toolSpec` and
  `cachePoint`; a cache point is emitted as its own entry directly after the tool it covers.
- A tool excluded by `toolChoice: { oneOf }` takes its cache point with it, so a cache point never
  slides onto an unrelated tool, and a tool list left with no tool specs omits `toolConfig`
  entirely rather than sending a cache point on its own.
EOF
```

- [ ] **Step 5: Final verification**

Run: `pnpm vitest --run packages/ai/amazon-bedrock/test`
Expected: PASS.

Run: `pnpm check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add .changeset/amazon-bedrock-tool-definition-caching.md
git commit -m "docs(amazon-bedrock): changeset for tool-definition caching"
```

`TODO.md` is untracked by design and is not committed.
