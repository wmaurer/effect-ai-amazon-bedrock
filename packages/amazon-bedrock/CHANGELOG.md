# @wmaurer/effect-ai-amazon-bedrock

## 0.1.0

The first release under this name. The entries summarize the changesets in `docs/changesets/`, which an upstream pull request to Effect would reuse. Two entries differ from them. The entry on `x-amzn-errortype` has no changeset yet, and the entry on the AWS error message covers a 401 as well as the 403 that its changeset names.

### Minor Changes

- Add an Amazon Bedrock provider for `effect/ai`. It calls the Converse and ConverseStream APIs, signs requests with SigV4 through `aws4fetch`, and decodes the AWS event-stream framing without another dependency.
- Add tool calling to `generateText`. The provider sends `toolConfig` with the tools and the `toolChoice`, decodes `toolUse` blocks into `tool-call` parts, and sends tool results back as `toolResult` blocks.
- Add structured output. `generateObject` sends the schema in the Converse `outputConfig.textFormat` field, so your own tools can go with it. The models on the provider's list, which are the Claude 3 models and Claude Sonnet 4 and Opus 4, get the object through a tool that replaces your tools. If the model calls the tool more than once, the first call is the object. Every model also gets the tool when `structuredOutputs` is `false`, and when the prompt holds tool calls but no tools go out, because Converse rejects such a request without a `toolConfig`. On the tool path, models that reject a forced `toolChoice`, such as Claude Opus 5.5 and Sonnet 5.5, get the tool unforced. `Config.structuredOutputs` overrides the choice of path, `Config.forcedToolChoice` overrides whether the tool is forced, and `Config.outputConfig` takes `effort`.
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
- Keep the AWS error message in the `AuthenticationError` of a 401 or 403 response. The message tells wrong credentials apart from a model that the account cannot use.
- Set the `kind` of the `AuthenticationError` from the AWS exception name in the `x-amzn-errortype` header of a 401 or 403 response. `AccessDeniedException` gives `InsufficientPermissions`, and `ExpiredTokenException` gives `ExpiredKey`. `UnrecognizedClientException`, `InvalidSignatureException`, and `IncompleteSignatureException` give `InvalidKey`, and `MissingAuthenticationTokenException` gives `MissingKey`. Without the header, or with another name, a 401 gives `InvalidKey` and a 403 gives `InsufficientPermissions`.
- Encode `CachePointBlock.ttl` with `Schema.optionalKey`, so the `amazonBedrock` provider options satisfy `Schema.Json`.
- Fail `generateText` and `streamText` with `InvalidUserInputError`, before the request is sent, when the prompt holds tool calls or tool results and the request carries no `toolConfig`. Converse answers such a request with a 400. The error names the workaround: pass the toolkit that produced the tool calls, with `toolChoice: "auto"`.
- Redact the `X-Amz-Security-Token` header in the request and response headers of an `AiError` and in an HTTP span that records headers. `converse` and `converseStream` add the header to the names in `Headers.CurrentRedactedNames`, so the names that you set stay redacted too. An error from a request signed with temporary credentials does not show the session token.
