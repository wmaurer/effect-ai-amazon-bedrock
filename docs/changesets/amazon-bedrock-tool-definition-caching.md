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
