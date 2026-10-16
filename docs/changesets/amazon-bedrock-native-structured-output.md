---
"@effect/ai-amazon-bedrock": minor
---

`generateObject` now requests structured output through Converse's native `outputConfig.textFormat` json_schema mode, so the caller's own tools can go out with it, and it now works on Claude Opus 5.5.

- Models on the provider's list of models without native support get the object through a tool instead, and that tool replaces the caller's toolkit. The list holds the Claude 3 models and Claude Sonnet 4 and Opus 4, taken from Anthropic's capability table, and Claude Opus 5.5, for which Bedrock rejected `outputConfig.textFormat` in a live run. Every other model gets the native mode.
- The tool is forced where the model accepts a forced `toolChoice`. Claude Opus 5.5, Sonnet 5.5, Fable 5.1, and Mythos 5.1 reject a forced `toolChoice`, so on them the tool is left unforced and the request tells the model to call it. Sonnet 5.5, Fable 5.1, and Mythos 5.1 take the tool path only when `Config.structuredOutputs` is `false`.
- Add `Config.structuredOutputs`, which overrides the provider's choice between the native mode and the tool.
- Add `outputConfig` to `ConverseRequest`, with the `OutputConfig`, `OutputFormat`, `OutputFormatStructure`, and `JsonSchemaDefinition` schemas. `Config.outputConfig` exposes only `effort`, and the provider sets `textFormat` from the response format.
