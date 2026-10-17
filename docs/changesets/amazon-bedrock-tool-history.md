---
"@effect/ai-amazon-bedrock": patch
---

Handle a prompt that holds tool calls or tool results in a request that offers no tools, which Converse answers with a 400.

- `generateObject` asks for the object through the object tool in that case, on every model, so the request carries a `toolConfig`.
- `generateText` and `streamText` fail with `InvalidUserInputError` before the request is sent. The error names the causes, which are no tools, a `oneOf` that names none of them, or `toolChoice: "none"`, which Converse cannot express, and the workaround: pass the toolkit that produced the tool calls, with `toolChoice: "auto"`. A request that carries a `toolConfig` from the request config is not affected.
