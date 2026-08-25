/**
 * Live checks that the authentication-error classification matches what AWS actually sends.
 *
 * `internal/errors.ts` maps five AWS exception shapes onto `AuthenticationError.kind`, and
 * only two of them were ever observed — the rest were read off the AWS documentation. The
 * mapping keys on the `x-amzn-errortype` response header, so a header AWS spells differently
 * than the table expects silently falls through to `InsufficientPermissions` and sends the
 * reader to IAM for a problem IAM cannot fix.
 *
 * These calls are rejected at the signature check, so they reach no model and cost nothing.
 *
 * See ./README.md — this whole directory is temporary and comes out before the branch is
 * squashed for the upstream PR.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { AiError, LanguageModel } from "effect/unstable/ai"
import { brokenCredentialsLayer, liveDisabled, unsignedLayer } from "./helpers.ts"

const TIMEOUT = 60_000

/**
 * Reads the AWS exception name off the diagnostic context.
 *
 * Header values are `Redacted` when the header is one of the redacted set, so both shapes
 * have to be handled. AWS suffixes the type with an endpoint url (`Exception:https://...`),
 * which is what the mapping table strips before looking the name up.
 */
const errorTypeOf = (reason: typeof AiError.AuthenticationError.Type): string | undefined => {
  const header = reason.http?.response?.headers["x-amzn-errortype"]
  if (header === undefined) return undefined
  const value = Redacted.isRedacted(header) ? Redacted.value(header) : header
  return value.split(":")[0]
}

/**
 * Fails the request and returns the `AuthenticationError` reason, asserting on the way that
 * the failure really was an authentication error rather than, say, a validation error that
 * happens also to be a 4xx.
 */
const authenticationFailure = (
  layer: ReturnType<typeof brokenCredentialsLayer> | ReturnType<typeof unsignedLayer>
) =>
  Effect.gen(function*() {
    const error = yield* Effect.flip(
      LanguageModel.generateText({ prompt: "Reply with exactly: ok" }).pipe(Effect.provide(layer))
    )
    assert.instanceOf(error, AiError.AiError)
    assert.strictEqual(error.reason._tag, "AuthenticationError")
    return error.reason as typeof AiError.AuthenticationError.Type
  })

describe.skipIf(liveDisabled)("Amazon Bedrock authentication errors (live)", { sequential: true }, () => {
  it.effect("classifies an unknown access key id as InvalidKey", () =>
    Effect.gen(function*() {
      const reason = yield* authenticationFailure(
        // Syntactically valid and correctly signed, but AWS has no such key.
        brokenCredentialsLayer({ accessKeyId: "AKIAIOSFODNN7EXAMPLE" })
      )

      assert.strictEqual(reason.kind, "InvalidKey")
      // Pins the header value the table is keyed on. The previous run only established that
      // *some* 403 arrived and that it classified as InvalidKey — which three of the five
      // mapped exception shapes would do, so it did not pin down this one.
      assert.strictEqual(errorTypeOf(reason), "UnrecognizedClientException")
    }), TIMEOUT)

  it.effect("classifies a bad signature as InvalidKey", () =>
    Effect.gen(function*() {
      const reason = yield* authenticationFailure(
        // A real, live access key id paired with the wrong secret: AWS recognises the key,
        // then fails the signature. A different exception shape from the case above, mapped
        // to the same kind by a different table entry.
        brokenCredentialsLayer({ secretAccessKey: "wJalrXUtnFEMIbadK7MDENGbPxRfiCYEXAMPLEKEY" })
      )

      assert.strictEqual(reason.kind, "InvalidKey")
      assert.strictEqual(errorTypeOf(reason), "InvalidSignatureException")
    }), TIMEOUT)

  it.effect("keeps the AWS message on the reason rather than a bare status", () =>
    Effect.gen(function*() {
      const reason = yield* authenticationFailure(
        brokenCredentialsLayer({ accessKeyId: "AKIAIOSFODNN7EXAMPLE" })
      )

      // The flat `{ "message": ... }` body Bedrock returns is not Anthropic's nested shape;
      // decoding it wrong leaves `description` undefined and the reader with only "403".
      assert.isDefined(reason.description)
      assert.isAtLeast(reason.description!.length, 1)
    }), TIMEOUT)

  it.effect("classifies an unsigned request as InsufficientPermissions", () =>
    Effect.gen(function*() {
      const reason = yield* authenticationFailure(unsignedLayer())

      // Documented as the `MissingAuthenticationTokenException` case; Bedrock disagrees. The
      // request that has no `Authorization` header at all comes back as
      // `AccessDeniedException` with "Authorization header is missing", so `MissingKey` is
      // not the kind a reader gets, and the third table entry is pinned by this instead.
      assert.strictEqual(errorTypeOf(reason), "AccessDeniedException")
      assert.strictEqual(reason.kind, "InsufficientPermissions")
      // This is also the only observed response that spells the body key `Message`; the
      // lower-case `message` of every other error would decode even if the schema dropped it.
      assert.strictEqual(reason.description, "Authorization header is missing")
    }), TIMEOUT)

  it.effect("signs without a session token when none is configured", () =>
    Effect.gen(function*() {
      const reason = yield* authenticationFailure(
        // The live credentials are a temporary `ASIA…` triple, which AWS rejects without its
        // session token — so the failure is expected. What it establishes is that the signer
        // omits `x-amz-security-token` cleanly rather than signing an `undefined` value:
        // a malformed canonical request fails as `IncompleteSignatureException` or
        // `InvalidSignatureException` well before AWS looks the token up at all.
        brokenCredentialsLayer({ sessionToken: undefined })
      )

      assert.strictEqual(errorTypeOf(reason), "UnrecognizedClientException")
      assert.strictEqual(reason.kind, "InvalidKey")
    }), TIMEOUT)
})
