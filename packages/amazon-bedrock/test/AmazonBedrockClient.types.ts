// The rejected cases trip Effect diagnostics as well as the type errors they expect.
// @effect-diagnostics missingEffectError:off missingLayerContext:off
import { AmazonBedrockClient } from "@wmaurer/effect-ai-amazon-bedrock"
import { Config, Context, Effect, type Layer, Redacted } from "effect"
import { AiError } from "effect/ai"
import type { HttpClient } from "effect/http"

// The shapes of `@aws-sdk/credential-providers`, copied so the package does not depend on the SDK.
interface AwsCredentialIdentity {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  readonly credentialScope?: string
  readonly expiration?: Date
  readonly accountId?: string
}
interface AwsIdentityProperties {
  callerClientConfig?: {
    profile?: string
    region(): Promise<string>
  }
}
// `fromNodeProviderChain()`
declare const fromNodeProviderChain: () => (
  options?: AwsIdentityProperties & { forceRefresh?: boolean }
) => Promise<AwsCredentialIdentity>
// `fromTemporaryCredentials()`, `fromContainerMetadata()`, and the other single providers
declare const fromTemporaryCredentials: () => (
  identityProperties?: Record<string, any>
) => Promise<AwsCredentialIdentity>

type Client = AmazonBedrockClient.AmazonBedrockClient

const loadCredentials: Effect.Effect<AmazonBedrockClient.Credentials, AiError.AuthenticationError> = Effect.succeed({
  accessKeyId: "AKIA",
  secretAccessKey: "secret",
  expiration: new Date()
})

class Secrets extends Context.Service<Secrets, {
  readonly load: Effect.Effect<AmazonBedrockClient.Credentials, AiError.AuthenticationError>
}>()("Secrets") {}

const loadFromSecrets = Effect.gen(function*() {
  const secrets = yield* Secrets
  return yield* secrets.load
})

const networkError = new AiError.NetworkError({
  reason: "TransportError",
  request: { method: "GET", url: "https://vault.example.com", urlParams: [], hash: undefined, headers: {} }
})

// Accepted, with no requirement besides `HttpClient`

export const accepted: ReadonlyArray<Layer.Layer<Client, never, HttpClient.HttpClient>> = [
  AmazonBedrockClient.layer({ region: "eu-west-1", credentialProvider: fromNodeProviderChain() }),
  AmazonBedrockClient.layer({ credentialProvider: fromTemporaryCredentials() }),
  AmazonBedrockClient.layer({ credentialProvider: async () => ({ accessKeyId: "AKIA", secretAccessKey: "secret" }) }),
  AmazonBedrockClient.layer({ credentialProvider: loadCredentials }),
  AmazonBedrockClient.layer({ credentialProvider: Effect.fail(networkError) }),
  AmazonBedrockClient.layer({
    credentialProvider: Effect.fail(AiError.make({ module: "Vault", method: "load", reason: networkError }))
  }),
  AmazonBedrockClient.layer({ apiKey: Redacted.make("key") })
]

export const acceptedConfig: ReadonlyArray<Layer.Layer<Client, Config.ConfigError, HttpClient.HttpClient>> = [
  AmazonBedrockClient.layerConfig({
    region: Config.String("AWS_REGION"),
    apiKey: Config.Redacted("AWS_BEARER_TOKEN_BEDROCK")
  }),
  AmazonBedrockClient.layerConfig({ credentialProvider: fromNodeProviderChain() })
]

// 0.1.0 calls, which still infer no requirement besides `HttpClient`

export const v010: ReadonlyArray<Layer.Layer<Client, never, HttpClient.HttpClient>> = [
  AmazonBedrockClient.layer({ accessKeyId: "AKIA", secretAccessKey: Redacted.make("secret") }),
  AmazonBedrockClient.layer({
    apiUrl: "https://proxy.example.com",
    accessKeyId: "AKIA",
    secretAccessKey: Redacted.make("secret"),
    sessionToken: Redacted.make("token"),
    region: "eu-west-1",
    transformClient: (client) => client
  })
]

export const v010Config: ReadonlyArray<Layer.Layer<Client, Config.ConfigError, HttpClient.HttpClient>> = [
  AmazonBedrockClient.layerConfig({
    accessKeyId: Config.String("AWS_ACCESS_KEY_ID"),
    secretAccessKey: Config.Redacted("AWS_SECRET_ACCESS_KEY")
  }),
  AmazonBedrockClient.layerConfig({
    apiUrl: Config.String("BEDROCK_URL"),
    accessKeyId: Config.String("AWS_ACCESS_KEY_ID"),
    secretAccessKey: Config.Redacted("AWS_SECRET_ACCESS_KEY"),
    sessionToken: Config.Redacted("AWS_SESSION_TOKEN").pipe(Config.withDefault(Redacted.make(""))),
    region: Config.String("AWS_REGION"),
    transformClient: (client) => client
  })
]

export const v010Make: Effect.Effect<AmazonBedrockClient.Service, never, HttpClient.HttpClient> = AmazonBedrockClient
  .make({ accessKeyId: "AKIA", secretAccessKey: Redacted.make("secret") })

// A provider that requires a service makes the layer require it

export const withSecrets: Layer.Layer<Client, never, HttpClient.HttpClient | Secrets> = AmazonBedrockClient.layer({
  credentialProvider: loadFromSecrets
})

export const withSecretsConfig: Layer.Layer<Client, Config.ConfigError, HttpClient.HttpClient | Secrets> =
  AmazonBedrockClient.layerConfig({ region: Config.String("AWS_REGION"), credentialProvider: loadFromSecrets })

export const withSecretsMake: Effect.Effect<AmazonBedrockClient.Service, never, HttpClient.HttpClient | Secrets> =
  AmazonBedrockClient.make({ credentialProvider: loadFromSecrets })

// @ts-expect-error the layer requires Secrets
export const withoutSecrets: Layer.Layer<Client, never, HttpClient.HttpClient> = AmazonBedrockClient.layer({
  credentialProvider: loadFromSecrets
})

// Rejected

export const rejected = [
  // @ts-expect-error two ways to authenticate
  AmazonBedrockClient.layer({ apiKey: Redacted.make("key"), accessKeyId: "AKIA", secretAccessKey: Redacted.make("s") }),
  // @ts-expect-error two ways to authenticate
  AmazonBedrockClient.layer({ credentialProvider: fromNodeProviderChain(), accessKeyId: "AKIA" }),
  // @ts-expect-error two ways to authenticate
  AmazonBedrockClient.layer({ credentialProvider: loadCredentials, apiKey: Redacted.make("key") }),
  // @ts-expect-error two ways to authenticate
  AmazonBedrockClient.layerConfig({ apiKey: Config.Redacted("KEY"), accessKeyId: Config.String("ID") }),
  // @ts-expect-error no way to authenticate
  AmazonBedrockClient.layer({ region: "eu-west-1" }),
  // @ts-expect-error no way to authenticate
  AmazonBedrockClient.layerConfig({ region: Config.String("AWS_REGION") }),
  // @ts-expect-error an access key ID without a secret access key
  AmazonBedrockClient.layer({ accessKeyId: "AKIA" }),
  // @ts-expect-error a plain-string API key
  AmazonBedrockClient.layer({ apiKey: "key" }),
  // @ts-expect-error a plain-string secret access key
  AmazonBedrockClient.layer({ accessKeyId: "AKIA", secretAccessKey: "secret" }),
  // @ts-expect-error an Effect that fails with an unrelated error
  AmazonBedrockClient.layer({ credentialProvider: Effect.fail(new Error("boom")) }),
  // @ts-expect-error an Effect that fails with a ConfigError
  AmazonBedrockClient.layer({ credentialProvider: Effect.flatMap(Config.String("ID"), () => loadCredentials) })
]
