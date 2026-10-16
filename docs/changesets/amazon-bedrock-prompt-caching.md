---
"@effect/ai-amazon-bedrock": minor
---

Add prompt caching to the Amazon Bedrock provider.

- Model the Converse `cachePoint` block and add it to both `ContentBlock` and `SystemContentBlock`. `SystemContentBlock` is a union, so its `text` member is now optional.
- Request a cache point through the `amazonBedrock` provider options of a message (system, user, assistant, tool) or of a text, file, tool call or tool result part: `options: { amazonBedrock: { cachePoint: { type: "default" } } }`. An optional `ttl` of `"5m"` or `"1h"` opts into extended caching; omitting it leaves the lifetime to Bedrock.
- Converse caches the prefix preceding a cache point rather than the block it is attached to, so the cache point is emitted as its own block after the content it covers — after that part's block, or after the last block of that message.
- Cache hits and writes were already reported: usage decoding reads `cacheReadInputTokens` and `cacheWriteInputTokens`.
