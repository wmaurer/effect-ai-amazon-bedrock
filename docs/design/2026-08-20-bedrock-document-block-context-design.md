# Amazon Bedrock `DocumentBlock.context` — Design

**Package:** `@effect/ai-amazon-bedrock`
**Date:** 2026-08-20
**Status:** Approved for implementation

## Goal

Let a document file part carry Converse's `DocumentBlock.context` — free text telling the model
how to interpret that document.

## Background

`DocumentBlock` has five members: `format`, `name`, `source`, `context` and `citations`. This
provider models all but `context`.

`context` and `citations` are the same kind of thing: the document block's tuning surface, both
optional, both attached per document. This branch ships `citations` — the response path decodes
`citationsContent` blocks and deltas into document source parts, and `FilePartOptions` already
carries a `citations` field. Shipping that surface with `context` missing leaves the feature
incomplete rather than absent, which is the argument for doing it now rather than deferring it
with the rest of `TODO.md`.

Two findings from the Smithy model shaped the scope:

1. **`context` is unconstrained.** Its target is a bare `smithy.api#String` with no traits beyond
   documentation. Its sibling `name` carries `smithy.api#length {min: 1, max: 200}` and a
   documented restricted alphabet; `context` carries neither. Any validation this provider added
   would be invented rather than modelled.

2. **The documentation scopes it to citations, the model does not.** AWS describes it as
   "Contextual information about how the document should be processed or interpreted by the model
   when generating citations." But the member has no trait tying it to `citations`, and the two
   are independent optional members of the same structure.

**Scope:** `context` only. `DocumentSource.content` stays in `TODO.md` as its own item — it needs
a decision this one does not (see Non-goals).

## Decision: `context` is sent unconditionally

A file part that sets `context` without enabling `citations` still sends `context`.

The alternatives were to drop it silently or to reject the request. Both were declined. Dropping
caller input silently is the hardest failure mode to debug, and rejecting invents a constraint the
API does not state — the request would be one Bedrock accepts. Passing it through keeps the
provider a faithful mapping onto Converse and leaves the question of what the field does to
Bedrock, which is the only party that can answer it. This mirrors how `citations` is already
handled: the caller sets it, the provider sends it.

## Design

### 1. Schema

One field on `DocumentBlock` (`AmazonBedrockSchema.ts:239`), between `source` and `citations` to
match Smithy member order:

```ts
context: Schema.optional(Schema.String),
```

`Schema.optional` matches the surrounding optional members. No refinement, per finding 1 above.

### 2. Provider option

One field on `FileOptions` (`AmazonBedrockLanguageModel.ts:238`), beside `citations`:

```ts
readonly context?: string | null
```

Its doc comment states what it is (guidance the model reads when interpreting the document) and
that it is ignored for image file parts. That disposition is not new policy: `context` is a
`DocumentBlock` member, and an image part never reaches the branch that builds a document block,
exactly as with `citations` today.

### 3. Conversion

In the `documentFormat` branch of `prepareMessages` (`AmazonBedrockLanguageModel.ts:781-795`),
read `context` beside `citations` and spread it the same way, so an unset or `null` option omits
the key rather than sending `undefined`:

```ts
...(Predicate.isNullish(context) ? {} : { context }),
```

Placed before the `citations` spread, matching the schema field order. No conditional on
`citations`, per the decision above.

### 4. Errors

None. There is no new failure point: the value is an already-typed string copied onto the request
body, with no decoding, validation or lookup.

## Non-goals

`DocumentSource.content` is untouched. It carries a document as pre-chunked `{ text }` blocks and
is what makes `documentChunk` citations meaningful, but `Prompt.FilePart` carries a single `data`
and cannot express "this document is these five sections". Modelling it means a provider option
carrying document *payload* rather than *configuration* — the first in this repo — and that
decision is unresolved. Nothing in this design depends on it or forecloses it.

## Testing

Request-body assertions via the existing `captureUserContent` helper, in the style of the
citations tests at `AmazonBedrockLanguageModel.test.ts:951`:

- a document part with `context` set emits it on the document block
- a document part with `context` set and no `citations` still emits `context` — this is the
  decision above, so it gets a test that fails if the coupling is ever added
- a document part with neither option emits no `context` key at all
- schema level: a `DocumentBlock` carrying `context` encodes and round-trips

## Documentation

`TODO.md`'s "`DocumentSource.content` and `DocumentBlock.context`" section becomes a
`DocumentSource.content` section. The trailing sentence about `context` is dropped; the rest of
the entry, which is about `content`, is unchanged.

The `AmazonBedrockLanguageModel` module doc comment is unchanged — it already describes citations
as opt-in per document, and `context` is a detail of that surface rather than a new capability.

A changeset accompanies the change.
