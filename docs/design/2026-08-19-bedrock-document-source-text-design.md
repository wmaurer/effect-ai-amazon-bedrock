# Amazon Bedrock `DocumentSource.text` — Design

**Package:** `@effect/ai-amazon-bedrock`
**Date:** 2026-08-19
**Status:** Approved for implementation

## Goal

Send text documents to the Converse API as `source.text` rather than base64 `source.bytes`.

## Background

The Converse `DocumentSource` union has four members — `bytes`, `s3Location`, `text` and
`content`. This provider models the first two. `text` carries a document as a plain JSON string;
`content` carries it as a list of pre-chunked `{ text }` blocks.

Three findings shaped the scope:

1. **`text` and `content` have unrelated payoffs.** `text` saves wire size: base64 inflates by
   about a third, and JSON string escaping gives some of that back, so the net is roughly a
   quarter smaller request for text documents. It changes nothing else. `content` is the member
   with a capability behind it — `DocumentChunkLocation.start` and `.end` are chunk indices, so a
   `documentChunk` citation has nothing to index into unless the request supplied chunks.

2. **`content` needs a user-facing surface; `text` does not.** A `Prompt.FilePart` carries
   `mediaType` plus a single `data`, which is everything the `text` path needs. It cannot express
   "this document is these five sections." That would require a new `amazonBedrock` file-part
   option carrying document payload rather than configuration — the first option in this repo to
   do so. That is a separate decision, and nothing about `text` depends on it.

3. **The TODO entry's prior-art claim was wrong.** It stated the vercel-ai provider sends text
   media types as text. It does not: `convert-to-amazon-bedrock-chat-messages.ts:231-240` uses
   `source: { bytes: convertToBase64(new TextEncoder().encode(part.data.text)) }`, and its
   `AmazonBedrockDocumentBlock` type declares `source: { bytes: string }` only. No provider in
   `.repos` emits `source.text`.

Both `text` and `content` are GA in the released AWS SDK
(`clients/client-bedrock-runtime/src/models/models_0.ts:2565-2583`), not preview.

**Scope:** `text` only. `content` stays in `TODO.md` as its own item.

## Accepted uncertainty

AWS documents model support for `s3Location` but not for `text` or `content`, and this repo's
tests mock `fetch` — nothing here calls Bedrock. Whether Bedrock treats a `text` source
identically to a `txt`-format `bytes` source (same parsing, same character offsets for citations)
cannot be verified from this repository. The design accepts that: the package is unreleased and
has no consumers, so this is a one-time design judgment rather than a migration risk, and routing
is automatic rather than an opt-in that would push an unverifiable question onto callers.

## Design

### 1. Schema: add `DocumentSource`, keep `MediaSource`

`MediaSource` (`AmazonBedrockSchema.ts:178`) is unchanged — `bytes | s3Location`. That is the
correct shape for Smithy's `ImageSource`, and also for `VideoSource`, the next `TODO.md` item, so
the shared struct keeps earning its name. `ImageBlock.source` continues to use it.

A new sibling adds the third member:

```ts
export const DocumentSource = Schema.Struct({
  ...MediaSource.fields,
  text: Schema.optional(Schema.String)
})
```

`Schema.optional` matches the surrounding union members; this is a request-body position, not a
`Json` value, so the `optionalKey` constraint that applies to provider options does not apply.

`DocumentBlock.source` (`AmazonBedrockSchema.ts:223`) moves to `DocumentSource`. `content` is
deliberately absent.

### 2. Conversion: `text/*` documents go as text

The routing rule is the media type prefix. Of the nine entries in `documentFormats`
(`AmazonBedrockLanguageModel.ts:621-631`), exactly four are `text/*` — `text/csv`, `text/html`,
`text/plain`, `text/markdown` — and those are exactly the textual ones. No second lookup table is
introduced; `part.mediaType.startsWith("text/")` is the whole rule.

`fileSource` (`AmazonBedrockLanguageModel.ts:644`) is unchanged and continues to serve image
parts. A sibling resolver handles document parts, in this order:

| Condition | Result |
| --- | --- |
| `data` is an `s3:` URL | `{ s3Location }` — unchanged. `text` applies only to inline data. |
| media type is not `text/*` | `{ bytes }` — unchanged. PDF, Word and Excel keep going as base64. |
| `data` is a `Uint8Array` | `{ text: new TextDecoder().decode(data) }` |
| `data` is a `string` | base64 per the `FilePart` contract: `Encoding.decodeBase64String(data)` |

The first two rows delegate to `fileSource` unchanged, so URL handling — including the existing
`InvalidUserInputError` for a non-`s3:` URL — stays in one place and is not duplicated. Only the
last two rows are new code.

### 3. Errors

Base64 decoding is the one new failure point. `Encoding.decodeBase64String` returns a `Result`; on
failure the document resolver raises an `AiError.InvalidUserInputError` from `prepareMessages`,
naming the offending file part and its media type. This matches what the module already does for
unsupported media types and non-s3 URLs, and matches its header comment's stated policy of
erroring rather than silently dropping content.

This is strictly better than the current behaviour: a `text/plain` part carrying non-base64 data
is forwarded verbatim today and returns an opaque 400 from Bedrock. It now fails locally with a
message that says what is wrong.

UTF-8 decoding cannot fail — `TextDecoder` substitutes U+FFFD rather than throwing. A mislabelled
latin-1 or UTF-16 file will be mangled, as it already is today, since Bedrock must assume an
encoding of its own.

### 4. Citations: unchanged

`citations` still attaches to the document block, and `documentChar` offsets index into the same
text either way. No interaction with this change.

## Testing

Assertions on the serialized request body, in the existing test style:

- `text/plain` with base64 string data produces `source: { text }` and no `bytes`
- `text/markdown` with `Uint8Array` data produces `source: { text }`
- `application/pdf` still produces `source: { bytes }`
- `text/csv` with an `s3://` URL still produces `source: { s3Location }`
- `text/plain` with data that is not valid base64 fails with `InvalidUserInputError`
- schema level: a `DocumentSource` carrying `text` encodes and round-trips

## Documentation

`TODO.md`'s "`DocumentSource.text` and `.content`" entry becomes a `DocumentSource.content` entry
recording that `text` shipped, that `content` is what makes chunk-granular citations meaningful,
and that it requires a provider option carrying document content rather than configuration. The
incorrect vercel-ai claim is dropped.

A changeset accompanies the change.
