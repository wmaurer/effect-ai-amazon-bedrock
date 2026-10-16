---
"@effect/ai-amazon-bedrock": minor
---

Add non-streaming tool calling, tool-result messages, and structured output to the Amazon Bedrock provider.

- `toolConfig` (tools + `toolChoice`) is now sent for `generateText` requests with a toolkit; `auto` / `required` / named / `oneOf` tool choices are supported.
- Assistant tool-call parts and tool-result messages round-trip through Converse `toolUse` / `toolResult` blocks; `toolUse` responses decode into `tool-call` parts.
- Structured output (`generateObject` / `responseFormat: "json"`) uses Converse's native `outputConfig.textFormat` json_schema mode, or a tool call on the models the provider lists as lacking native support, with `toCodecAnthropic` as the schema `codecTransformer` — appropriate for Bedrock-hosted Anthropic Claude models. A model-family-aware transformer is left for a follow-up.
- Structured output is available only on the non-streaming path (`generateObject`), because `LanguageModel.streamText` always requests text.
