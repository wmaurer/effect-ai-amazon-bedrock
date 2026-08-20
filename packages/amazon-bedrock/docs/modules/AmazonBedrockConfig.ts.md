---
title: AmazonBedrockConfig.ts
nav_order: 2
parent: Modules
---

## AmazonBedrockConfig.ts overview

The `AmazonBedrockConfig` module provides contextual configuration for the
Amazon Bedrock AI provider integration. It is used to customize the
underlying HTTP client without changing individual request code.

Since v4.0.0

---

## Exports Grouped by Category

- [configuration](#configuration)
  - [withClientTransform](#withclienttransform)
- [services](#services)
  - [AmazonBedrockConfig (class)](#amazonbedrockconfig-class)
- [utils](#utils)
  - [AmazonBedrockConfig (namespace)](#amazonbedrockconfig-namespace)
    - [Service (interface)](#service-interface)

---

# configuration

## withClientTransform

Runs an effect with an `AmazonBedrockConfig` override that transforms the
underlying `HttpClient` used by Amazon Bedrock requests.

**Signature**

```ts
declare const withClientTransform: {
  (transform: (client: HttpClient) => HttpClient): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(self: Effect.Effect<A, E, R>, transform: (client: HttpClient) => HttpClient): Effect.Effect<A, E, R>
}
```

[Source](https://github.com/Effect-TS/effect/tree/main/packages/ai/amazon-bedrock/src/AmazonBedrockConfig.ts#L59)

Since v4.0.0

# services

## AmazonBedrockConfig (class)

Service tag for Amazon Bedrock client configuration overrides, such as
transformations applied to the underlying HTTP client.

**Signature**

```ts
declare class AmazonBedrockConfig
```

[Source](https://github.com/Effect-TS/effect/tree/main/packages/ai/amazon-bedrock/src/AmazonBedrockConfig.ts#L20)

Since v4.0.0

# utils

## AmazonBedrockConfig (namespace)

Namespace containing types associated with the `AmazonBedrockConfig` service.

[Source](https://github.com/Effect-TS/effect/tree/main/packages/ai/amazon-bedrock/src/AmazonBedrockConfig.ts#L40)

Since v4.0.0

### Service (interface)

Configuration provided through `AmazonBedrockConfig`.

**Signature**

```ts
export interface Service {
  readonly transformClient?: ((client: HttpClient) => HttpClient) | undefined
}
```

[Source](https://github.com/Effect-TS/effect/tree/main/packages/ai/amazon-bedrock/src/AmazonBedrockConfig.ts#L47)

Since v4.0.0
