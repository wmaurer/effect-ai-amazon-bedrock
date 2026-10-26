import * as AiError from "effect/ai/AiError"
import type * as Response from "effect/ai/Response"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import type * as HttpClientError from "effect/http/HttpClientError"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Redactable from "effect/Redactable"
import * as Schema from "effect/Schema"
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

/** @internal */
export const mapCredentialProviderError =
  (method: string) => (error: AiError.AiError | AiError.AiErrorReason): AiError.AiError =>
    AiError.isAiError(error) ? error : AiError.make({ module: "AmazonBedrockClient", method, reason: error })

// Bedrock REST errors are FLAT `{ "message": "..." }` (AWS uses both casings),
// with the exception type carried in the `x-amzn-errortype` header — NOT
// Anthropic's nested `{ error: { type, message } }`. Schema-guarded so a
// non-conforming body safely yields `undefined`.
const BedrockErrorBody = Schema.fromJsonString(Schema.Struct({
  message: Schema.optional(Schema.String),
  Message: Schema.optional(Schema.String)
}))

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
  const decoded = Schema.decodeUnknownOption(BedrockErrorBody)(body)
  const message = Option.isSome(decoded)
    ? decoded.value.message ?? decoded.value.Message
    : undefined

  const reason = mapStatusCodeToReason({
    status,
    message,
    errorType: extractErrorType(response.headers["x-amzn-errortype"]),
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

  if (params.message && dataRetentionRejection.test(params.message)) {
    parts.push(dataRetentionHint)
  }

  return parts.join(" ")
}

// Converse has no request field for the data retention mode, so the AWS message
// alone leaves the reader looking for one. Only an account-level setting in each
// region, which the control plane sets, makes such a model callable.
const dataRetentionRejection = /data retention mode '[^']*' is not available for this model/

const dataRetentionHint = "The account's data retention mode in this region does not allow this model." +
  " Claude Fable 5 and 5.1 need `aws_review`." +
  " Set the mode with the Bedrock PutAccountDataRetention operation:" +
  " https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html"

/**
 * AWS sends the exception shape as `Name:http://internal.amazon.com/coral/...`.
 * Only the part before the colon identifies it.
 */
const extractErrorType = (header: string | undefined): string | undefined =>
  Predicate.isUndefined(header) ? undefined : header.split(":")[0]

/**
 * Bedrock answers 403 for four unrelated problems and 401 for a fifth, and the
 * status alone cannot tell them apart — a bad key, an expired session token and a
 * model the account is not entitled to all arrive as 403. Reporting every one of
 * them as `InsufficientPermissions` sends people to IAM even when IAM is fine;
 * expired `aws login` credentials are the common case. The exception shape in
 * `x-amzn-errortype` is what actually distinguishes them.
 */
const authenticationKinds: Record<string, typeof AiError.AuthenticationError.Type["kind"]> = {
  AccessDeniedException: "InsufficientPermissions",
  ExpiredTokenException: "ExpiredKey",
  IncompleteSignatureException: "InvalidKey",
  InvalidSignatureException: "InvalidKey",
  MissingAuthenticationTokenException: "MissingKey",
  UnrecognizedClientException: "InvalidKey"
}

/** @internal */
export const mapStatusCodeToReason = ({ errorType, http, message, status }: {
  readonly status: number
  readonly message: string | undefined
  readonly errorType?: string | undefined
  readonly http: typeof AiError.HttpContext.Type
}): AiError.AiErrorReason => {
  // AWS sends this with a 400, but the request is well formed. The account has
  // used up a quota, which a short retry delay will not restore.
  if (errorType === "ServiceQuotaExceededException") {
    return new AiError.QuotaExhaustedError({ http })
  }

  // The exception shape is often the only clue to the cause, as when a 400
  // arrives with the body `{}`.
  const describe = (text: string | undefined): string | undefined =>
    Predicate.isUndefined(errorType) ? text : Predicate.isUndefined(text) ? errorType : `${errorType}: ${text}`

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
        description: describe(invalidRequestDescription),
        http
      })
    case 401:
    case 403:
      return new AiError.AuthenticationError({
        kind: (Predicate.isNotUndefined(errorType) ? authenticationKinds[errorType] : undefined)
          // No header, or a shape we do not know: fall back to what the status implies.
          ?? (status === 401 ? "InvalidKey" : "InsufficientPermissions"),
        description: describe(message),
        http
      })
    case 408:
      // ModelTimeoutException: the request took too long to process.
      return new AiError.InternalProviderError({
        description: describe(message) ?? "Model timeout",
        http
      })
    case 424:
      // ModelErrorException: the model returned an error response.
      return new AiError.InternalProviderError({
        description: describe(message) ?? "Model error",
        http
      })
    case 429:
      return new AiError.RateLimitError({
        http
      })
    default:
      if (status >= 500) {
        return new AiError.InternalProviderError({
          description: describe(message) ?? "Server error",
          http
        })
      }
      return new AiError.UnknownError({
        description: describe(message),
        http
      })
  }
}
