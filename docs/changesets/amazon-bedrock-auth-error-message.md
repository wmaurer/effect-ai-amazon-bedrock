---
"@effect/ai-amazon-bedrock": patch
---

Surface the AWS error message on authentication failures.

A 403 from Bedrock means either that the credentials are wrong or that the
account is not entitled to the requested model, and only the server's message
separates the two. It was being discarded, so both surfaced as
`InsufficientPermissions: Your API key lacks required permissions`, which
points at IAM even when IAM is fine.
