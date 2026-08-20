---
title: AmazonBedrockEventStream.ts
nav_order: 3
parent: Modules
---

## AmazonBedrockEventStream.ts overview

The `AmazonBedrockEventStream` module decodes the AWS binary event-stream
framing used by the Bedrock `converse-stream` endpoint into typed events.

**Wire format**

Each frame is laid out as
`[totalLen u32be][headersLen u32be][preludeCrc u32][headers...][payload...][msgCrc u32]`.

Headers are a sequence of `[nameLen u8][name][valueType u8][value...]` entries.
We only need the string headers (`:message-type`, `:event-type`,
`:content-type`), but must still advance correctly over non-string value
types. Event payloads are JSON, wrapped under their `:event-type` key to match
the Converse stream event schema.

See the [AWS Documentation](https://docs.aws.amazon.com/lexv2/latest/dg/event-stream-encoding.html)
for more information.

Since v4.0.0

---

## Exports Grouped by Category

- [constructors](#constructors)
  - [makeChannel](#makechannel)
- [errors](#errors)
  - [EventStreamError (class)](#eventstreamerror-class)

---

# constructors

## makeChannel

Builds a channel that decodes AWS event-stream frames into values of the
provided schema.

**Signature**

```ts
declare const makeChannel: <A, I, RD, IE, Done>(
  schema: Schema.Codec<A, I, RD>
) => Channel.Channel<
  NonEmptyReadonlyArray<A>,
  IE | Schema.SchemaError | EventStreamError,
  Done,
  NonEmptyReadonlyArray<Uint8Array>,
  IE,
  Done,
  RD
>
```

[Source](https://github.com/Effect-TS/effect/tree/main/packages/ai/amazon-bedrock/src/AmazonBedrockEventStream.ts#L140)

Since v4.0.0

# errors

## EventStreamError (class)

Raised when the event stream carries a transport-level error frame
(`:message-type: error`). These frames have no JSON body; the error is
described by the `:error-code` and `:error-message` headers.

**Signature**

```ts
declare class EventStreamError
```

[Source](https://github.com/Effect-TS/effect/tree/main/packages/ai/amazon-bedrock/src/AmazonBedrockEventStream.ts#L38)

Since v4.0.0
