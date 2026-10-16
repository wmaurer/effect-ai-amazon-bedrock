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
