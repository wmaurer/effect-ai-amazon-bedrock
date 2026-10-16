---
"@effect/ai-amazon-bedrock": minor
---

Add streaming tool calling to the Amazon Bedrock provider.

- `streamText` no longer rejects requests carrying a toolkit; `toolConfig` is sent on `converse-stream` exactly as it is on `converse`.
- Converse `contentBlockStart` / `contentBlockDelta` frames now decode their `toolUse` member, so streamed tool calls surface as `tool-params-start`, `tool-params-delta`, `tool-params-end`, and a final `tool-call` part. Bedrock streams tool arguments as partial JSON, which is accumulated per content-block index and parsed at `contentBlockStop`.
- Structured output is still only available on the non-streaming path (`generateObject`); `LanguageModel.streamText` always requests text.
