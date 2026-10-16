---
"@effect/ai-amazon-bedrock": minor
---

Add non-streaming tool calling, tool-result messages, and structured output to the Amazon Bedrock provider.

- `toolConfig` (tools + `toolChoice`) is now sent for `generateText` requests with a toolkit; `auto` / `required` / named / `oneOf` tool choices are supported.
- Assistant tool-call parts and tool-result messages round-trip through Converse `toolUse` / `toolResult` blocks; `toolUse` responses decode into `tool-call` parts.
- Structured output (`generateObject` / `responseFormat: "json"`) is implemented as a forced tool call (Converse has no native json_schema mode), using `toCodecAnthropic` as the schema `codecTransformer` — appropriate for Bedrock-hosted Anthropic Claude models. A model-family-aware transformer is left for a follow-up.
- Streaming tool calls and streaming structured output remain unsupported and fail loudly via `streamText`; use `generateText` / `generateObject`.
