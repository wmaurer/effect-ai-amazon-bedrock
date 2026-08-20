---
title: AmazonBedrockClient.ts
nav_order: 1
parent: Modules
---

## AmazonBedrockClient.ts overview

The `AmazonBedrockClient` module defines the low-level Effect service used to
call Amazon Bedrock's Converse API. It wraps an `HttpClient` with SigV4
request signing (via `aws4fetch`), request defaults, response decoding, and
error mapping to the unified `AiError` type.

**Mental model**

`HttpClient.HttpClient` provides the transport. `make` turns explicit
`Options` into an `AmazonBedrockClient` service, while
`layer` and `layerConfig` provide that service as a layer. The
service exposes handwritten helpers for the `converse` (non-streaming) and
`converse-stream` (streaming) endpoints.

Since v4.0.0

---

## Exports Grouped by Category

- [constructors](#constructors)
  - [make](#make)
- [layers](#layers)
  - [layer](#layer)
  - [layerConfig](#layerconfig)
- [models](#models)
  - [Service (interface)](#service-interface)
- [options](#options)
  - [Options (type alias)](#options-type-alias)
- [services](#services)
  - [AmazonBedrockClient (class)](#amazonbedrockclient-class)

---

# constructors

## make

Creates an Amazon Bedrock client service with the given options.

**Signature**

```ts
declare const make: (options: Options) => Effect.Effect<Service, never, HttpClient.HttpClient>
```

[Source](https://github.com/Effect-TS/effect/tree/main/packages/ai/amazon-bedrock/src/AmazonBedrockClient.ts#L126)

Since v4.0.0

# layers

## layer

Creates a layer for the Amazon Bedrock client with the given options.

**Signature**

```ts
declare const layer: (options: Options) => Layer.Layer<AmazonBedrockClient, never, HttpClient.HttpClient>
```

[Source](https://github.com/Effect-TS/effect/tree/main/packages/ai/amazon-bedrock/src/AmazonBedrockClient.ts#L220)

Since v4.0.0

## layerConfig

Creates a layer for the Amazon Bedrock client, loading credentials and other
settings via Effect's `Config` module.

**Signature**

```ts
declare const layerConfig: (options: {
  readonly apiUrl?: Config.Config<string> | undefined
  readonly accessKeyId: Config.Config<string>
  readonly secretAccessKey: Config.Config<Redacted.Redacted<string>>
  readonly sessionToken?: Config.Config<Redacted.Redacted<string>> | undefined
  readonly region?: Config.Config<string> | undefined
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}) => Layer.Layer<AmazonBedrockClient, Config.ConfigError, HttpClient.HttpClient>
```

[Source](https://github.com/Effect-TS/effect/tree/main/packages/ai/amazon-bedrock/src/AmazonBedrockClient.ts#L230)

Since v4.0.0

# models

## Service (interface)

Represents the Amazon Bedrock client service with methods for the Converse
API, including regular and streaming message creation.

**Signature**

```ts
export interface Service {
  /**
   * Creates a message using the Bedrock Converse API and maps all errors to the
   * unified `AiError` type.
   */
  readonly converse: (options: {
    readonly payload: typeof ConverseRequest.Encoded
  }) => Effect.Effect<ConverseResponse, AiError.AiError>

  /**
   * Creates a streaming message using the Bedrock `converse-stream` API and maps
   * all errors to the unified `AiError` type.
   */
  readonly converseStream: (options: {
    readonly payload: typeof ConverseRequest.Encoded
  }) => Stream.Stream<ConverseResponseStreamEvent, AiError.AiError>
}
```

[Source](https://github.com/Effect-TS/effect/tree/main/packages/ai/amazon-bedrock/src/AmazonBedrockClient.ts#L50)

Since v4.0.0

# options

## Options (type alias)

Configuration for creating an Amazon Bedrock client.

**Signature**

```ts
type Options = {
  /**
   * The base URL for the Bedrock runtime API. Override to use a proxy or a
   * different endpoint.
   *
   * @default `https://bedrock-runtime.${region}.amazonaws.com`
   */
  readonly apiUrl?: string | undefined
  readonly accessKeyId: string
  readonly secretAccessKey: Redacted.Redacted<string>
  readonly sessionToken?: Redacted.Redacted<string> | undefined
  /**
   * The AWS region.
   *
   * @default "us-east-1"
   */
  readonly region?: string | undefined
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}
```

[Source](https://github.com/Effect-TS/effect/tree/main/packages/ai/amazon-bedrock/src/AmazonBedrockClient.ts#L92)

Since v4.0.0

# services

## AmazonBedrockClient (class)

Service tag for the Amazon Bedrock client.

**Signature**

```ts
declare class AmazonBedrockClient
```

[Source](https://github.com/Effect-TS/effect/tree/main/packages/ai/amazon-bedrock/src/AmazonBedrockClient.ts#L78)

Since v4.0.0
