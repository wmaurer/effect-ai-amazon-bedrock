# @wmaurer/effect-ai-amazon-bedrock

## 0.1.0

The first release under this name. The entries come from the changesets in `docs/changesets/`, which an upstream pull request to Effect would reuse.

### Minor Changes

- Add an Amazon Bedrock provider for `effect/ai`. It calls the Converse and ConverseStream APIs, signs requests with SigV4 through `aws4fetch`, and decodes the AWS event-stream framing without another dependency.
- Add tool calling to `generateText`. The provider sends `toolConfig` with the tools and the `toolChoice`, decodes `toolUse` blocks into `tool-call` parts, and sends tool results back as `toolResult` blocks. `generateObject` runs as a forced tool call and does not use the Converse `outputConfig` field.
- Add tool calling to `streamText`. Streamed tool calls arrive as `tool-params-start`, `tool-params-delta`, `tool-params-end`, and a final `tool-call` part.
- Send `file` prompt parts as Converse `image` and `document` blocks. The provider accepts JPEG, PNG, GIF, and WebP images, and PDF, CSV, DOC, DOCX, XLS, XLSX, HTML, TXT, and Markdown documents. File data can be base64, a `Uint8Array`, or an `s3://` URL. Other media types and other URLs fail with `InvalidUserInputError`.
- Send a cited `text/*` document as a `text` source instead of base64. An uncited text document still goes as `bytes`, because Converse rejects a `text` source without a citations config.
- Send `context` on a document block through the `amazonBedrock.context` option of a file part.
- Add document citations. The `amazonBedrock.citations` option of a file part opts the document in. Citations come back as `source` parts whose `amazonBedrock` metadata names the cited span.
- Add prompt caching. The `amazonBedrock.cachePoint` option of a message or part adds a cache point after that content, with an optional `ttl` of `"5m"` or `"1h"`.
- Add tool-definition caching. Annotate a tool with `AmazonBedrockLanguageModel.ToolCachePoint` to cache the tool list up to that tool.
- Add reasoning. `reasoningContent` blocks decode into `reasoning` parts on both paths, and reasoning parts go back to Bedrock in later turns with their signature or redacted payload.

### Patch Changes

- Add `additionalModelRequestFields` to the request config, so `withConfigOverride` can pass model-specific fields such as the `thinking` block that turns on extended thinking.
- Keep the AWS error message on a 403 response. The `InsufficientPermissions` error now carries that message, which tells wrong credentials apart from a model that the account cannot use.
- Encode `CachePointBlock.ttl` with `Schema.optionalKey`, so the `amazonBedrock` provider options satisfy `Schema.Json`.
