# Tool-definition caching — `@effect/ai-amazon-bedrock`

Date: 2026-08-19

## Problem

Converse's `Tool` union accepts a `cachePoint` alongside `toolSpec`, so a tool list can be
cached like message content. The provider does not emit one today: prompt caching is
implemented for every message and content part, but the tool definitions — often the largest
stable prefix of a request — cannot be cached at all.

`TODO.md` recorded this as blocked on a missing config surface. It is not. `effect/unstable/ai/Tool`
carries `Context.Reference` annotations (`Tool.Strict`, `Tool.Readonly`, ...), read with
`Context.get(tool.annotations, ref)`, and a provider package can define its own reference.

## Surface

A per-tool annotation, exported from `AmazonBedrockLanguageModel`:

```ts
export const ToolCachePoint = Context.Reference<CachePoint | undefined>(
  "@effect/ai-amazon-bedrock/AmazonBedrockLanguageModel/ToolCachePoint",
  { defaultValue: () => undefined }
)
```

```ts
const search = Tool.make("search", { ... })
  .annotate(AmazonBedrockLanguageModel.ToolCachePoint, { type: "default" })
```

The value is the already-exported `CachePoint` type, so `ttl` behaves exactly as it does for
message and part cache points.

This mirrors the existing prompt-caching model: a cache point covers everything preceding it,
and is attached to the last element of the prefix it should cover. Caching the whole tool list
means annotating the last tool; caching only the stable ones means annotating the last stable
one and declaring volatile tools after it.

Rejected alternatives:

- **A `Config` field appended after the whole tool list.** Simpler for the dominant case, but
  offers no prefix granularity and makes caching a property of the request rather than of the
  tool it covers.
- **Both.** Two surfaces and a precedence rule to document, for a capability most callers will
  use one way only.

## Schema

`Tool` becomes union-shaped, following the all-members-optional convention already used for
`ContentBlock`, `ImageSource` and the citation blocks:

```ts
export class Tool extends Schema.Class<Tool>(makeIdentifier("Tool"))({
  toolSpec: Schema.optional(ToolSpecification),
  cachePoint: Schema.optional(CachePointBlock)
}) {}
```

The union's third member, `systemTool`, stays unmodelled: it selects Bedrock-hosted tools this
provider cannot invoke. It joins the unmodelled-by-design list in `TODO.md`.

## Encoding

`prepareTools` reads the annotation per tool and pushes `{ cachePoint }` immediately after that
tool's `{ toolSpec }` entry. Three existing behaviours shift:

1. The `toolChoice: { oneOf }` filter currently reads `t.toolSpec.name` on every entry. It
   becomes a filter over each tool together with its cache point, so excluding a tool takes its
   cache point with it. A cache point is a property of the tool it follows, not a free-floating
   marker that should slide onto an unrelated neighbour.
2. The `tools.length > 0` guard that decides whether to send `toolConfig` becomes "at least one
   `toolSpec`". Converse's `tools` has a minimum length of 1 and a lone cache point covers
   nothing.
3. The synthesized structured-output tool config is untouched — it holds one generated tool with
   no annotations to read.

## Testing

Test-driven, one behaviour per test, against the existing request-capture fixtures in
`test/AmazonBedrockLanguageModel.test.ts`:

- a cache point is emitted after an annotated tool, and not after unannotated ones
- `ttl` on the annotation reaches the request
- `toolChoice: { oneOf }` excluding the annotated tool drops its cache point as well

## Out of scope

Cache-read and cache-write token reporting is already implemented and is unchanged: Converse
reports cache usage per request, not per cached section.
