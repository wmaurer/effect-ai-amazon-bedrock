# Amazon Bedrock `DocumentBlock.context` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a document file part carry Converse's `DocumentBlock.context` — free text telling the
model how to interpret that document.

**Architecture:** Three small additions along one existing path. `AmazonBedrockSchema.DocumentBlock`
gains an optional `context` string so the request encoder stops dropping the key; the `FileOptions`
interface in `AmazonBedrockLanguageModel.ts` gains a matching `context` provider option; and the
document branch of `prepareMessages` copies the option onto the block it already builds. There is no
new module, no new resolver and no new failure mode.

**Tech Stack:** TypeScript, `effect` (`Schema`, `Predicate`), `@effect/vitest`, pnpm workspaces,
changesets.

## Global Constraints

- Package: `@effect/ai-amazon-bedrock` (`packages/ai/amazon-bedrock`).
- Spec: `docs/superpowers/specs/2026-08-20-bedrock-document-block-context-design.md`.
- `context` is sent **unconditionally** — a file part that sets `context` without enabling
  `citations` still sends `context`. Never gate it on `citations`.
- No validation on `context`. The Smithy model gives it no `length` trait and no charset
  restriction, unlike its sibling `name`. Do not add a refinement, a trim, or a non-empty check.
- Field order matters for readability and matches the Smithy member order: `context` goes **before**
  `citations` in both the schema class and the request-body spread.
- Provider options must satisfy `Schema.Json | null`. Use `readonly context?: string | null` —
  an optional key whose value may be `null`, exactly like the neighbouring `citations`.
- Tests: `pnpm vitest run --project @effect/ai-amazon-bedrock`
- Typecheck: `pnpm --filter @effect/ai-amazon-bedrock check`
- Lint: `pnpm lint` (runs `oxlint -f unix && dprint check`)
- Commits on this branch use conventional-commit subjects with a scope and end with the trailer
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/ai/amazon-bedrock/src/AmazonBedrockSchema.ts` | Wire shapes for the Converse API | Add one optional field to `DocumentBlock` (line 239) |
| `packages/ai/amazon-bedrock/test/AmazonBedrockSchema.test.ts` | Schema encode/decode round-trips | Add one round-trip test |
| `packages/ai/amazon-bedrock/src/AmazonBedrockLanguageModel.ts` | Prompt → request conversion, response decoding | Add one field to `FileOptions` (line 238) and one spread in `prepareMessages` (line 781) |
| `packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts` | Request-body and response assertions | Add two request-body tests |
| `TODO.md` | Deliberately-unmodelled Converse capabilities | Drop the `context` sentence from the combined section |
| `.changeset/amazon-bedrock-document-context.md` | Release note | Create |

Task 1 must land before Task 2: `Schema.Struct` encoding drops keys the schema does not declare, so
the request-body tests in Task 2 cannot pass until the schema field exists.

---

### Task 1: Schema field on `DocumentBlock`

**Files:**
- Modify: `packages/ai/amazon-bedrock/src/AmazonBedrockSchema.ts:239-244`
- Test: `packages/ai/amazon-bedrock/test/AmazonBedrockSchema.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `AmazonBedrockSchema.DocumentBlock` gains an optional field
  `context?: string | undefined`. Task 2 relies on this field existing, because it is what lets the
  encoded `ConverseRequest` carry a `context` key on a document block.

The class today reads:

```ts
export class DocumentBlock extends Schema.Class<DocumentBlock>(makeIdentifier("DocumentBlock"))({
  format: Schema.Literals(["pdf", "csv", "doc", "docx", "xls", "xlsx", "html", "txt", "md"]),
  name: Schema.String,
  source: DocumentSource,
  citations: Schema.optional(CitationsConfig)
}) {}
```

- [ ] **Step 1: Write the failing test**

Append this test inside the `describe("AmazonBedrockSchema", ...)` block in
`packages/ai/amazon-bedrock/test/AmazonBedrockSchema.test.ts`, directly after the existing
`"round-trips a document block carrying a text source"` test (currently at line 82):

```ts
  it.effect("round-trips a document block carrying context", () =>
    Effect.gen(function*() {
      const encoded = yield* Schema.encodeEffect(AmazonBedrockSchema.DocumentBlock)(
        new AmazonBedrockSchema.DocumentBlock({
          format: "pdf",
          name: "report",
          source: { bytes: "AQID" },
          context: "A quarterly earnings report. Prefer the tables over the prose."
        })
      )
      assert.strictEqual(encoded.context, "A quarterly earnings report. Prefer the tables over the prose.")

      const decoded = yield* Schema.decodeUnknownEffect(AmazonBedrockSchema.DocumentBlock)(encoded)
      assert.strictEqual(decoded.context, "A quarterly earnings report. Prefer the tables over the prose.")
      assert.isUndefined(decoded.citations)
    }))
```

The `assert.isUndefined(decoded.citations)` line is not decoration: it is the schema-level half of
the "context does not require citations" decision in the spec.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project @effect/ai-amazon-bedrock -t "round-trips a document block carrying context"`

Expected: FAIL, because `DocumentBlock` does not declare `context`. Either failure mode is correct:
the constructor rejects the unknown property, or it drops it and
`assert.strictEqual(encoded.context, ...)` receives `undefined`. If the test passes, the field
already exists — stop and report that.

- [ ] **Step 3: Add the field**

In `packages/ai/amazon-bedrock/src/AmazonBedrockSchema.ts`, add one line to the `DocumentBlock`
fields, between `source` and `citations`:

```ts
export class DocumentBlock extends Schema.Class<DocumentBlock>(makeIdentifier("DocumentBlock"))({
  format: Schema.Literals(["pdf", "csv", "doc", "docx", "xls", "xlsx", "html", "txt", "md"]),
  name: Schema.String,
  source: DocumentSource,
  context: Schema.optional(Schema.String),
  citations: Schema.optional(CitationsConfig)
}) {}
```

Then extend the class's existing doc comment. It currently reads:

```ts
/**
 * A document content block.
 *
 * **Details**
 *
 * `name` is required and Bedrock restricts it to alphanumerics, single runs of
 * whitespace, hyphens, parentheses and square brackets.
 *
 * @category schemas
 * @since 4.0.0
 */
```

Replace the `**Details**` paragraph block with:

```ts
/**
 * A document content block.
 *
 * **Details**
 *
 * `name` is required and Bedrock restricts it to alphanumerics, single runs of
 * whitespace, hyphens, parentheses and square brackets.
 *
 * `context` is free text telling the model how to interpret the document. AWS
 * documents it in terms of citations, but the model constrains it neither in
 * length nor in alphabet and does not tie it to `citations`, so it is sent
 * whenever it is set.
 *
 * @category schemas
 * @since 4.0.0
 */
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project @effect/ai-amazon-bedrock -t "round-trips a document block carrying context"`
Expected: PASS.

- [ ] **Step 5: Run the whole package suite, typecheck and lint**

```bash
pnpm vitest run --project @effect/ai-amazon-bedrock
pnpm --filter @effect/ai-amazon-bedrock check
pnpm lint
```

Expected: all pass, output clean. If `dprint check` complains, run `pnpm dprint fmt` and re-run.

- [ ] **Step 6: Commit**

```bash
git add packages/ai/amazon-bedrock/src/AmazonBedrockSchema.ts \
        packages/ai/amazon-bedrock/test/AmazonBedrockSchema.test.ts
git commit -m "$(cat <<'MSG'
feat(amazon-bedrock): model DocumentBlock.context

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: Provider option, conversion, docs and changeset

**Files:**
- Modify: `packages/ai/amazon-bedrock/src/AmazonBedrockLanguageModel.ts:231-252` (the `FileOptions`
  doc comment and interface) and `:781-796` (the document branch of `prepareMessages`)
- Modify: `TODO.md:15-25`
- Create: `.changeset/amazon-bedrock-document-context.md`
- Test: `packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts`

**Interfaces:**
- Consumes: `AmazonBedrockSchema.DocumentBlock` now declares an optional `context: string` field
  (Task 1). Without it the encoder silently drops the key and these tests fail.
- Produces: the `amazonBedrock` file-part option `readonly context?: string | null`, set as
  `options: { amazonBedrock: { context: "..." } }` on a `Prompt.makePart("file", ...)`. Nothing
  later in this plan depends on it.

Context you need about the test file: `captureUserContent(parts)` (defined at
`packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts:634`) builds a single user
message from the given prompt parts, runs `LanguageModel.generateText` against a stubbed HTTP
handler, and returns the decoded `messages[0].content` array from the request body that would have
been sent. It asserts nothing itself — you assert on what it returns. The nearest existing example
is `"enables citations on a document block when requested"` at line 951.

- [ ] **Step 1: Write the failing tests**

In `packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts`, insert these two tests
immediately after the existing `"enables citations on a document block when requested"` test (which
ends at line 963, just before the `const generateWithDocument = ...` helper):

```ts
    it.effect("sends context on a document block when requested", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", {
            mediaType: "application/pdf",
            fileName: "report.pdf",
            data: "AQID",
            options: {
              amazonBedrock: {
                context: "A quarterly earnings report.",
                citations: { enabled: true }
              }
            }
          })
        ])

        assert.deepStrictEqual(content, [{
          document: {
            format: "pdf",
            name: "report",
            source: { bytes: "AQID" },
            context: "A quarterly earnings report.",
            citations: { enabled: true }
          }
        }])
      }))

    it.effect("sends context on a document block with citations disabled", () =>
      Effect.gen(function*() {
        const content = yield* captureUserContent([
          Prompt.makePart("file", {
            mediaType: "application/pdf",
            fileName: "report.pdf",
            data: "AQID",
            options: { amazonBedrock: { context: "A quarterly earnings report." } }
          })
        ])

        assert.deepStrictEqual(content, [{
          document: {
            format: "pdf",
            name: "report",
            source: { bytes: "AQID" },
            context: "A quarterly earnings report."
          }
        }])
      }))
```

The second test is the guard on the spec's central decision: `context` is not gated on `citations`.
Its `deepStrictEqual` also proves no `citations` key leaks in.

The spec's third case — a document part with neither option emits no `context` key at all — is
already covered by the existing `"encodes a document file part as a document block"` test at line
680, whose `deepStrictEqual` compares against a document block with neither key. Do not duplicate
it; just confirm it still passes in Step 5.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project @effect/ai-amazon-bedrock -t "sends context on a document block"`

Expected: both FAIL on the `deepStrictEqual`, with the actual document block missing the `context`
key — nothing reads the option yet.

- [ ] **Step 3: Add the provider option**

In `packages/ai/amazon-bedrock/src/AmazonBedrockLanguageModel.ts`, the interface at line 238 today
reads:

```ts
/**
 * The provider options carried by a file prompt part.
 *
 * **Details**
 *
 * File parts are the only prompt parts that can request citations, so they
 * carry both the cache point every part accepts and the citations config.
 */
interface FileOptions {
  readonly amazonBedrock?: {
    /**
     * Marks the end of the reusable prefix of the request. The cache point is
     * emitted after the block this is attached to.
     */
    readonly cachePoint?: CachePoint | null
    /**
     * Opts the document into citations. Ignored for image file parts, which
     * Converse cannot cite.
     */
    readonly citations?: Citations | null
  } | null
}
```

Replace it with:

```ts
/**
 * The provider options carried by a file prompt part.
 *
 * **Details**
 *
 * File parts are the only prompt parts that map onto a document block, so they
 * carry the cache point every part accepts plus the two document-level knobs:
 * the citations config and the interpretation context.
 */
interface FileOptions {
  readonly amazonBedrock?: {
    /**
     * Marks the end of the reusable prefix of the request. The cache point is
     * emitted after the block this is attached to.
     */
    readonly cachePoint?: CachePoint | null
    /**
     * Guidance the model reads when interpreting the document, such as what
     * the document is or which parts of it matter. Sent whenever it is set,
     * independently of `citations`. Ignored for image file parts, which do not
     * become document blocks.
     */
    readonly context?: string | null
    /**
     * Opts the document into citations. Ignored for image file parts, which
     * Converse cannot cite.
     */
    readonly citations?: Citations | null
  } | null
}
```

- [ ] **Step 4: Add the conversion**

In the same file, the document branch of `prepareMessages` (line 781) today reads:

```ts
                    const documentFormat = documentFormats[part.mediaType]
                    if (Predicate.isNotUndefined(documentFormat)) {
                      const name = documentName(part.fileName, documents.length + 1)
                      const citations = part.options.amazonBedrock?.citations
                      documents.push({ name, mediaType: part.mediaType, fileName: part.fileName })
                      content.push({
                        document: {
                          format: documentFormat,
                          name,
                          source: yield* documentSource(part.mediaType, name, part.data),
                          ...(Predicate.isNullish(citations) ? {} : { citations })
                        }
                      })
                      pushCachePoint(content, part)
                      continue
                    }
```

Replace it with:

```ts
                    const documentFormat = documentFormats[part.mediaType]
                    if (Predicate.isNotUndefined(documentFormat)) {
                      const name = documentName(part.fileName, documents.length + 1)
                      const context = part.options.amazonBedrock?.context
                      const citations = part.options.amazonBedrock?.citations
                      documents.push({ name, mediaType: part.mediaType, fileName: part.fileName })
                      content.push({
                        document: {
                          format: documentFormat,
                          name,
                          source: yield* documentSource(part.mediaType, name, part.data),
                          ...(Predicate.isNullish(context) ? {} : { context }),
                          ...(Predicate.isNullish(citations) ? {} : { citations })
                        }
                      })
                      pushCachePoint(content, part)
                      continue
                    }
```

The conditional spread is what keeps an unset or `null` option from writing `context: undefined`
into the block. `Predicate` is already imported in this file — do not add an import.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm vitest run --project @effect/ai-amazon-bedrock
pnpm --filter @effect/ai-amazon-bedrock check
pnpm lint
```

Expected: the two new tests PASS, the whole package suite PASSES (in particular
`"encodes a document file part as a document block"` and
`"enables citations on a document block when requested"` are unchanged and still green), typecheck
and lint are clean. If `dprint check` complains, run `pnpm dprint fmt` and re-run.

- [ ] **Step 6: Update `TODO.md`**

`TODO.md` lines 15-25 today are one section covering two items. Change the heading and drop the
final sentence about `context`, leaving the rest — which is about `content` — untouched. The section
becomes exactly:

```markdown
## `DocumentSource.content`

`bytes`, `s3Location` and `text` are modelled; `content` is not. It carries a document as a list of
pre-chunked `{ text }` blocks, and it is what makes chunk-granular citations meaningful:
`DocumentChunkLocation.start` and `.end` are chunk indices, so a `documentChunk` citation has
nothing to index into unless the request supplied chunks. `Prompt.FilePart` carries a single `data`
and cannot express "this document is these five sections", so modelling it means a new
`amazonBedrock` file-part option carrying document payload rather than configuration — the first
option in this repo to do so. That is the decision to make before implementing it.
```

- [ ] **Step 7: Write the changeset**

Create `.changeset/amazon-bedrock-document-context.md` with exactly:

```markdown
---
"@effect/ai-amazon-bedrock": minor
---

Send `context` on Amazon Bedrock document blocks.

Set it through the `amazonBedrock` provider options of a file part:
`options: { amazonBedrock: { context: "A quarterly earnings report." } }`. It is free text telling
the model how to interpret that document, and it completes the Converse `DocumentBlock` surface
alongside `citations`. AWS documents the field in terms of citations, but the API neither ties the
two together nor constrains the string, so it is sent whenever it is set and is not validated here.
It is ignored for image file parts, which do not become document blocks.
```

- [ ] **Step 8: Re-run lint over the new files**

Run: `pnpm lint`
Expected: PASS. `dprint` formats markdown in this repo, so a mis-wrapped changeset or `TODO.md` will
fail here. Run `pnpm dprint fmt` if it does, then re-run.

- [ ] **Step 9: Commit**

```bash
git add packages/ai/amazon-bedrock/src/AmazonBedrockLanguageModel.ts \
        packages/ai/amazon-bedrock/test/AmazonBedrockLanguageModel.test.ts \
        TODO.md .changeset/amazon-bedrock-document-context.md
git commit -m "$(cat <<'MSG'
feat(amazon-bedrock): send document context from file part options

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Out of scope

`DocumentSource.content` — pre-chunked document payload — stays unimplemented and stays in
`TODO.md`. Nothing in this plan depends on it or forecloses it. Do not model it here.

No change to the `AmazonBedrockLanguageModel` module doc comment: it already describes citations as
opt-in per document, and `context` is a detail of that surface rather than a new capability.
