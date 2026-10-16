---
"@effect/ai-amazon-bedrock": patch
---

Make the Amazon Bedrock provider options satisfy `Schema.Json`.

`CachePointBlock.ttl` used `Schema.optional`, so its encoded type was `"5m" | "1h" | undefined`. That type reaches the `Prompt` provider options through the `amazonBedrock` cache point option, and those options are a record of `Schema.Json | null`, which admits a missing key but not an explicit `undefined`. `ttl` now uses `Schema.optionalKey`; a cache point is still written as `{ type: "default" }` or `{ type: "default", ttl: "1h" }`.
