/**
 * THROWAWAY smoke script — real Amazon Bedrock, real money. Not part of the build.
 *
 * Proves three things the downstream `jira-sync` work depends on:
 *   1. generateText   — signing, region, model id, model access
 *   2. generateObject — the forced-tool structured-output path
 *   3. cachePoint     — a second call over the same prefix reports cacheRead > 0
 *
 * Check 3 also settles the *disjointness* question: the provider maps
 * `uncached: inputTokens` and computes `total = inputTokens + cacheRead + cacheWrite`,
 * a convention transplanted from the Anthropic provider and never validated against
 * Bedrock. Bedrock returns its own `totalTokens`, which the provider discards. That
 * makes it a free oracle:
 *
 *   totalTokens == inputTokens + outputTokens
 *       -> inputTokens is INCLUSIVE of cached tokens; the provider's `total`
 *          double-counts and any cost model built on it over-bills.
 *   totalTokens == inputTokens + cacheRead + cacheWrite + outputTokens
 *       -> disjoint; the provider and the cost model are both correct as written.
 *
 * Run:
 *   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=eu-west-1 \
 *     pnpm tsx packages/ai/amazon-bedrock/smoke-bedrock.ts
 */
/* eslint-disable no-console -- printing the results IS this script's output */
import * as AmazonBedrockClient from "@effect/ai-amazon-bedrock/AmazonBedrockClient"
import * as AmazonBedrockLanguageModel from "@effect/ai-amazon-bedrock/AmazonBedrockLanguageModel"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"

/**
 * Sonnet 4.5, because Sonnet 5 and Opus 5 are gated on this account.
 *
 * 4.5 ids carry a version suffix (the 5.x ids do not) and 4.5 has NO In-Region
 * support in any region — every region is Geo or Global only. So the geo profile
 * is the expected path here, not a fallback. Check 1 still tries the bare id
 * first: if it somehow answers, that contradicts the model card and we want to
 * know. Whichever id answers is reported, because it decides which ARNs the IAM
 * policy needs.
 */
const BASE_MODEL = process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-sonnet-4-5-20250929-v1:0"
const GEO_MODEL = `eu.${BASE_MODEL}`

/** Set by check 1 to whichever id Bedrock actually accepted. */
let resolvedModel = BASE_MODEL

/** Raw `usage` objects exactly as Bedrock sent them, newest last. */
const rawUsages: Array<Record<string, number>> = []

/**
 * Bedrock's own `totalTokens` never reaches the provider's usage mapping, so we
 * capture the untouched response body on the way through.
 */
const captureRawUsage = (client: HttpClient.HttpClient) =>
  HttpClient.transformResponse(
    client,
    Effect.flatMap((response) =>
      Effect.map(response.json, (body) => {
        const usage = (body as any)?.usage
        if (usage !== undefined) rawUsages.push(usage)
        return response
      })
    )
  )

/**
 * Temporary credentials — from `aws login` or `aws sts assume-role` — come as a
 * triple and are rejected without the session token. Long-lived IAM user keys come
 * as a pair and must NOT carry one. Presence of the env var decides, because
 * `layerConfig` takes an optional `Config`, not a `Config` of an optional.
 */
const sessionTokenOption = process.env.AWS_SESSION_TOKEN === undefined
  ? {}
  : { sessionToken: Config.redacted("AWS_SESSION_TOKEN") }

const clientLayer = AmazonBedrockClient.layerConfig({
  accessKeyId: Config.string("AWS_ACCESS_KEY_ID"),
  secretAccessKey: Config.redacted("AWS_SECRET_ACCESS_KEY"),
  ...sessionTokenOption,
  region: Config.string("AWS_REGION").pipe(Config.withDefault("eu-west-1")),
  transformClient: captureRawUsage
}).pipe(Layer.provide(FetchHttpClient.layer))

const modelLayerFor = (model: string) => AmazonBedrockLanguageModel.layer({ model }).pipe(Layer.provide(clientLayer))

// =============================================================================
// 1. generateText
// =============================================================================

const sayOk = LanguageModel.generateText({ prompt: "Reply with exactly: ok" })

const checkGenerateText = Effect.gen(function*() {
  // In-region first — if it answers, the IAM policy needs only foundation-model ARNs.
  const inRegion = yield* Effect.result(sayOk.pipe(Effect.provide(modelLayerFor(BASE_MODEL))))
  if (inRegion._tag === "Success") {
    resolvedModel = BASE_MODEL
    console.log(`[1] generateText -> ${JSON.stringify(inRegion.success.text)}  (id: ${BASE_MODEL}, IN-REGION)`)
    return inRegion.success.text
  }

  console.log(`[1] in-region id ${BASE_MODEL} failed, retrying geo profile. Cause: ${inRegion.failure}`)
  const geo = yield* sayOk.pipe(Effect.provide(modelLayerFor(GEO_MODEL)))
  resolvedModel = GEO_MODEL
  console.log(`[1] generateText -> ${JSON.stringify(geo.text)}  (id: ${GEO_MODEL}, EU GEO)`)
  console.log("[1] NOTE: in-region did not work — the IAM policy needs inference-profile ARNs.")
  return geo.text
})

// =============================================================================
// 2. generateObject (forced tool choice)
//
// Sonnet 4.5's model card lists "Structured outputs" as SUPPORTED, so this should be
// uneventful. Worth noting for later: Sonnet 5's card lists it as NOT supported. That
// row should refer to Bedrock's own native structured-outputs feature rather than the
// forced tool choice via Converse toolConfig that this provider uses — but if we ever
// move to Sonnet 5, re-run this check before trusting it.
// =============================================================================

const Finding = Schema.Struct({
  severity: Schema.Literals(["low", "medium", "high"]),
  summary: Schema.String
})

const checkGenerateObject = Effect.gen(function*() {
  const response = yield* LanguageModel.generateObject({
    schema: Finding,
    objectName: "Finding",
    prompt: "A null pointer dereference crashes the server on every request. Classify it."
  })
  console.log("[2] generateObject ->", JSON.stringify(response.value))
  return response.value
})

// =============================================================================
// 3. cachePoint — and the totalTokens disjointness oracle
// =============================================================================

/**
 * Sonnet 4.5 needs >= 1024 tokens per checkpoint (Sonnet 5 >= 4096, Opus 5 >= 512). This pads well past
 * both so the check does not silently degrade into "prefix too small to cache".
 */
const bigPrefix = Array.from(
  { length: 1200 },
  (_, i) => `Rule ${i}: prefer explicit failure over silent fallback.`
).join("\n")

/**
 * Stated explicitly rather than left to Bedrock's default, because the two TTLs bill
 * cache WRITES at different rates — 5m at $3.75/1M, 1h at $6.00/1M against a $3.00/1M
 * input rate. Anyone doing arithmetic on the numbers this script prints has to know
 * which one produced them, so the script names it and reports it.
 */
const CACHE_TTL = "5m" as const

const cachedPrompt = (question: string) =>
  Prompt.fromMessages([
    Prompt.makeMessage("system", {
      content: bigPrefix,
      options: { amazonBedrock: { cachePoint: { type: "default", ttl: CACHE_TTL } } }
    }),
    Prompt.makeMessage("user", {
      content: [Prompt.makePart("text", { text: question })]
    })
  ])

const checkCachePoint = Effect.gen(function*() {
  // First call writes the cache.
  const first = yield* LanguageModel.generateText({ prompt: cachedPrompt("Say A.") })
  // Second call over the identical prefix should read it.
  const second = yield* LanguageModel.generateText({ prompt: cachedPrompt("Say B.") })

  const providerUsage = second.usage
  const raw = rawUsages[rawUsages.length - 1]

  console.log("[3] provider usage (2nd call):", JSON.stringify(providerUsage, null, 2))
  console.log("[3] RAW Bedrock usage (2nd call):", JSON.stringify(raw, null, 2))
  console.log("[3] provider usage (1st call):", JSON.stringify(first.usage, null, 2))

  const cacheRead = raw?.cacheReadInputTokens ?? 0
  const cacheWrite = raw?.cacheWriteInputTokens ?? 0
  const cacheHit = cacheRead > 0

  if (!cacheHit) {
    console.log(
      "[3] NO CACHE HIT. Prefix may be under the model minimum, or the ~5 minute TTL lapsed."
    )
  }

  // ---- the oracle -----------------------------------------------------------
  // Only meaningful when something was actually cached.
  let verdict = "INCONCLUSIVE (no cache hit — rerun once caching works)"
  if (cacheHit) {
    const inclusive = raw.totalTokens === raw.inputTokens + raw.outputTokens
    const disjoint = raw.totalTokens === raw.inputTokens + cacheRead + cacheWrite + raw.outputTokens
    verdict = disjoint && !inclusive
      ? "DISJOINT — provider `total` and any cost model built on it are correct"
      : inclusive && !disjoint
      ? "INCLUSIVE — provider `total` DOUBLE-COUNTS cached tokens; cost models over-bill"
      : `AMBIGUOUS — totalTokens=${raw.totalTokens} matches neither/both formulas`
  }
  console.log(`[3] cache TTL used: ${CACHE_TTL}`)
  console.log("[3] DISJOINTNESS VERDICT:", verdict)

  return { cacheHit, verdict }
})

// =============================================================================

const program = Effect.gen(function*() {
  const results: Array<string> = []

  const text = yield* Effect.result(checkGenerateText)
  results.push(`1. generateText:   ${text._tag === "Success" ? "PASS" : `FAIL — ${text.failure}`}`)
  if (text._tag === "Failure") {
    console.log("\n=== SMOKE RESULTS ===")
    console.log(results[0])
    console.log("Stopping: checks 2 and 3 need a working model id.")
    return
  }
  results.push(`   model id used:  ${resolvedModel} (${resolvedModel === BASE_MODEL ? "IN-REGION" : "EU GEO"})`)

  // Checks 2 and 3 run against whichever id check 1 proved works.
  const model = modelLayerFor(resolvedModel)

  const object = yield* Effect.result(checkGenerateObject.pipe(Effect.provide(model)))
  results.push(`2. generateObject: ${object._tag === "Success" ? "PASS" : `FAIL — ${object.failure}`}`)

  const cache = yield* Effect.result(checkCachePoint.pipe(Effect.provide(model)))
  results.push(
    `3. cachePoint:     ${
      cache._tag === "Success"
        ? cache.success.cacheHit ? "PASS" : "FAIL — cacheRead was 0"
        : `FAIL — ${cache.failure}`
    }`
  )
  if (cache._tag === "Success") {
    results.push(`   cache TTL used: ${CACHE_TTL}`)
    results.push(`   disjointness:   ${cache.success.verdict}`)
  }

  console.log("\n=== SMOKE RESULTS ===")
  for (const line of results) console.log(line)
})

Effect.runPromise(program).catch((error) => {
  console.error("smoke run failed:", error)
  process.exitCode = 1
})
