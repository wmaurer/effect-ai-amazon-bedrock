import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Redactable from "effect/Redactable"
import * as Schema from "effect/Schema"
import * as AiError from "effect/unstable/ai/AiError"
import type * as Response from "effect/unstable/ai/Response"
import type * as HttpClientError from "effect/unstable/http/HttpClientError"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import type { EventStreamError } from "../AmazonBedrockEventStream.ts"

// =============================================================================
// Error Mappers
// =============================================================================

/** @internal */
export const mapSchemaError = dual<
  (method: string) => (error: Schema.SchemaError) => AiError.AiError,
  (error: Schema.SchemaError, method: string) => AiError.AiError
>(2, (error, method) =>
  AiError.make({
    module: "AmazonBedrockClient",
    method,
    reason: AiError.InvalidOutputError.fromSchemaError(error)
  }))

/** @internal */
export const mapEventStreamError = dual<
  (method: string) => (error: EventStreamError) => AiError.AiError,
  (error: EventStreamError, method: string) => AiError.AiError
>(2, (error, method) =>
  AiError.make({
    module: "AmazonBedrockClient",
    method,
    reason: new AiError.InternalProviderError({
      description: `Event stream error frame${error.code ? ` [${error.code}]` : ""}: ${
        error.message ?? "no error message provided"
      }`
    })
  }))

/** @internal */
export const mapHttpClientError = dual<
  (method: string) => (error: HttpClientError.HttpClientError) => Effect.Effect<never, AiError.AiError>,
  (error: HttpClientError.HttpClientError, method: string) => Effect.Effect<never, AiError.AiError>
>(2, (error, method) => {
  const reason = error.reason
  switch (reason._tag) {
    case "TransportError": {
      return Effect.fail(AiError.make({
        module: "AmazonBedrockClient",
        method,
        reason: new AiError.NetworkError({
          reason: "TransportError",
          description: reason.description,
          request: buildHttpRequestDetails(reason.request)
        })
      }))
    }
    case "EncodeError": {
      return Effect.fail(AiError.make({
        module: "AmazonBedrockClient",
        method,
        reason: new AiError.NetworkError({
          reason: "EncodeError",
          description: reason.description,
          request: buildHttpRequestDetails(reason.request)
        })
      }))
    }
    case "InvalidUrlError": {
      return Effect.fail(AiError.make({
        module: "AmazonBedrockClient",
        method,
        reason: new AiError.NetworkError({
          reason: "InvalidUrlError",
          description: reason.description,
          request: buildHttpRequestDetails(reason.request)
        })
      }))
    }
    case "StatusCodeError": {
      return mapStatusCodeError(reason, method)
    }
    case "DecodeError": {
      return Effect.fail(AiError.make({
        module: "AmazonBedrockClient",
        method,
        reason: new AiError.InvalidOutputError({
          description: reason.description ?? "Failed to decode response"
        })
      }))
    }
    case "EmptyBodyError": {
      return Effect.fail(AiError.make({
        module: "AmazonBedrockClient",
        method,
        reason: new AiError.InvalidOutputError({
          description: reason.description ?? "Response body was empty"
        })
      }))
    }
  }
})

// Bedrock REST errors are FLAT `{ "message": "..." }` (AWS uses both casings),
// with the exception type carried in the `x-amzn-errortype` header — NOT
// Anthropic's nested `{ error: { type, message } }`. Schema-guarded so a
// non-conforming body safely yields `undefined`.
const BedrockErrorBody = Schema.Struct({
  message: Schema.optional(Schema.String),
  Message: Schema.optional(Schema.String)
})

/** @internal */
const mapStatusCodeError = Effect.fnUntraced(function*(
  error: HttpClientError.StatusCodeError,
  method: string
) {
  const { description, request, response } = error
  const status = response.status

  let body: string | undefined = description
  if (!description || !description.startsWith("{")) {
    const responseBody = yield* Effect.option(response.text)
    if (Option.isSome(responseBody) && responseBody.value) {
      body = responseBody.value
    }
  }

  // Promote the provider's error message to the structured reason (else 5xx
  // shows "Server error" and 4xx shows a bare "HTTP <status>").
  let json: unknown = undefined
  // @effect-diagnostics effect/tryCatchInEffectGen:off
  if (Predicate.isNotUndefined(body)) {
    try {
      json = JSON.parse(body)
    } catch {
      json = undefined
    }
  }
  const decoded = Schema.decodeUnknownOption(BedrockErrorBody)(json)
  const message = Option.isSome(decoded)
    ? decoded.value.message ?? decoded.value.Message
    : undefined

  const reason = mapStatusCodeToReason({
    status,
    message,
    http: buildHttpContext({ request, response, body })
  })

  return yield* AiError.make({ module: "AmazonBedrockClient", method, reason })
})

// =============================================================================
// HTTP Context
// =============================================================================

/** @internal */
export const buildHttpRequestDetails = (
  request: HttpClientRequest.HttpClientRequest
): typeof Response.HttpRequestDetails.Type => ({
  method: request.method,
  url: request.url,
  urlParams: Array.from(request.urlParams),
  hash: Option.getOrUndefined(request.hash),
  headers: Redactable.redact(request.headers) as Record<string, string>
})

/** @internal */
export const buildHttpContext = (params: {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response?: HttpClientResponse.HttpClientResponse
  readonly body?: string | undefined
}): typeof AiError.HttpContext.Type => ({
  request: buildHttpRequestDetails(params.request),
  response: Predicate.isNotUndefined(params.response)
    ? {
      status: params.response.status,
      headers: Redactable.redact(params.response.headers) as Record<string, string>
    }
    : undefined,
  body: params.body
})

// =============================================================================
// HTTP Status Code
// =============================================================================

const buildInvalidRequestDescription = (params: {
  readonly status: number
  readonly message: string | undefined
  readonly method: string
  readonly url: string
  readonly body: string | undefined
}): string => {
  const parts: Array<string> = []

  if (params.message) {
    parts.push(params.message)
  } else {
    parts.push(`HTTP ${params.status}`)
  }

  parts.push(`(${params.method} ${params.url})`)

  if (!params.message && params.body) {
    const truncated = params.body.length > 200
      ? params.body.slice(0, 200) + "..."
      : params.body
    parts.push(`Response: ${truncated}`)
  }

  return parts.join(" ")
}

/** @internal */
export const mapStatusCodeToReason = ({ http, message, status }: {
  readonly status: number
  readonly message: string | undefined
  readonly http: typeof AiError.HttpContext.Type
}): AiError.AiErrorReason => {
  const invalidRequestDescription = buildInvalidRequestDescription({
    status,
    message,
    method: http.request.method,
    url: http.request.url,
    body: http.body
  })

  switch (status) {
    case 400:
    case 404:
    case 422:
      return new AiError.InvalidRequestError({
        description: invalidRequestDescription,
        http
      })
    case 401:
      return new AiError.AuthenticationError({
        kind: "InvalidKey",
        http
      })
    case 403:
      return new AiError.AuthenticationError({
        kind: "InsufficientPermissions",
        http
      })
    case 408:
      // ModelTimeoutException: the request took too long to process.
      return new AiError.InternalProviderError({
        description: message ?? "Model timeout",
        http
      })
    case 424:
      // ModelErrorException: the model returned an error response.
      return new AiError.InternalProviderError({
        description: message ?? "Model error",
        http
      })
    case 429:
      return new AiError.RateLimitError({
        http
      })
    default:
      if (status >= 500) {
        return new AiError.InternalProviderError({
          description: message ?? "Server error",
          http
        })
      }
      return new AiError.UnknownError({
        description: message,
        http
      })
  }
}
