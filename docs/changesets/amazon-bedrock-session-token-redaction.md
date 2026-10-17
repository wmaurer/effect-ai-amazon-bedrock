---
"@effect/ai-amazon-bedrock": patch
---

Redact the session token in the headers of an `AiError`.

The client added `X-Amz-Security-Token` to `Headers.CurrentRedactedNames` only
while it was constructed, so `converse` and `converseStream` ran with the
default list. An error from a request signed with temporary credentials, and an
HTTP span that records headers, showed the session token in clear text. Both
methods now run with the header redacted, in addition to any names the caller
sets in `Headers.CurrentRedactedNames`.
