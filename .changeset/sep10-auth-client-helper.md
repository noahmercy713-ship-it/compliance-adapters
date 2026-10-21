---
'sep10-auth': minor
---

Add `authenticateWithSep10(options)` — a client-side helper for server-to-server
(Node/CLI) SEP-10 flows. It fetches a challenge, validates the server signature
and network passphrase, signs it with the provided keypair, and exchanges it
for a JWT in one call. Also exports `Sep10ClientError` with stable error codes
(`INVALID_KEYPAIR`, `INVALID_SERVER_SIGNATURE`, `NETWORK_MISMATCH`, etc.).
