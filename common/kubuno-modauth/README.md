# kubuno-modauth

The signed service-identity token that carries a caller's identity from the Kubuno
core to a module, so a module never has to trust a plain header.

```toml
kubuno-modauth = { git = "https://github.com/kubuno/core", tag = "modauth-v0.1.0", package = "kubuno-modauth" }
```

---

## The problem it closes

Every module runs as its own process listening on loopback, and the core is a
reverse proxy in front of them: it authenticates the caller, then forwards the
request with the caller's identity attached. When that identity travelled as plain
`X-Kubuno-User-Id` / `-Role` / `-Email` headers, any process able to reach a
module's loopback port could forge them and impersonate any user - administrators
included.

The core already derives a **distinct internal secret per module**. This crate binds
the forwarded identity to that secret: the core `sign`s a short-lived,
audience-bound token with the target module's secret, and the module `verify`s it
with its own copy.

- A forged header carries no valid signature.
- A token minted for one module does not validate at another: different secret
  **and** different audience.
- Its 30-second lifetime bounds replay on the loopback hop.

## Token format

```text
v1.<base64url(payload)>.<base64url(HMAC_SHA256(secret, "v1." + base64url(payload)))>
payload = {"sub","role","email","aud","iat","exp"}   (compact JSON)
```

The signature covers the exact bytes that travel on the wire, never a
re-serialised payload, so signer and verifier cannot disagree about encoding. The
verifier accepts **only** HMAC-SHA256 and reads no algorithm field from the message,
which rules out the `alg=none` and algorithm-confusion classes of bug. Signatures
are compared in constant time.

## API

| Item | Role |
|---|---|
| `TOKEN_HEADER` | the header the token travels in: `x-kubuno-auth` |
| `DEFAULT_TTL_SECS` | lifetime of a minted token: 30 s |
| `MAX_CLOCK_SKEW_SECS` | tolerated "issued in the future" drift: 5 s |
| `ModuleUser { id, role, email }` | the verified caller |
| `sign(secret, &user, aud) -> String` | mint a token (core side) |
| `verify(secret, token, expected_aud) -> Result<ModuleUser, VerifyError>` | check a token (module side) |
| `sign_at` / `verify_at` | the same with an explicit clock, for tests and non-default lifetimes |
| `VerifyError` | `Malformed`, `BadSignature`, `Expired`, `NotYetValid`, `WrongAudience` |

`VerifyError` is deliberately coarse: a module maps every variant to one flat
`401` and never echoes the reason, so the endpoint is not an oracle.

## Module side

A module's authentication middleware reads the token and verifies it with its own
internal secret and module id:

```rust
let token = req
    .headers()
    .get(kubuno_modauth::TOKEN_HEADER)
    .and_then(|v| v.to_str().ok())
    .ok_or(CalendarError::Unauthorized)?;

let user = kubuno_modauth::verify(
    state.settings.core.internal_secret.as_bytes(),
    token,
    MODULE_ID,
)
.map_err(|_| CalendarError::Unauthorized)?;
```

Routes under `/internal/*` are not reached through the proxy and carry no token;
they are authenticated separately, by the module's shared secret in
`X-Internal-Secret`.

## Who uses it

The core mints the tokens; the modules that verify them depend on the tagged
release above (app, assistant, calendar, chat, drive, flow, forms, forum, media,
notes, paintsharp, photos, tasks, wiki). The crate pins its own dependency
versions rather than inheriting a workspace's, so it resolves identically in every
module repository.

## Tests

```bash
cargo test -p kubuno-modauth
```

The unit tests cover the round trip, a wrong secret, a tampered payload, a wrong
audience, expiry, a token issued in the future, the tolerated clock skew and
malformed input.

## License

[AGPL-3.0-or-later](../../LICENSE) © Kubuno contributors.
