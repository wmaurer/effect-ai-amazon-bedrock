---
"@effect/ai-amazon-bedrock": minor
---

Send native structured output to Claude Opus 5.5, add `Config.forcedToolChoice`, and decode one object when the model calls the object tool twice.

- Claude Opus 5.5 gets Converse's native `outputConfig.textFormat`.
- `Config.forcedToolChoice` overrides whether the object tool that `generateObject` uses without native structured output is forced. With `structuredOutputs: false` it reaches the unforced tool for a model id the provider cannot classify, such as an application inference profile ARN. It does not change a `toolChoice` passed with your own tools.
- When the model calls the object tool more than once, the first call is the object.
