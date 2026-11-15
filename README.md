# 💥 Dunder LSP

_Work In Progress, not suited for production just yet._
_Contributions, suggestions and ideas are appreciated._
_Database schema and configuration are bound to change._

Dunder is a Lightning Service Provider for the Bitcoin Lightning Network.

It currently supports "on demand channel openings", meaning if a Lightning wallet
gets an inbound payment while not having any inbound capacity, Dunder will open
a channel to the wallet with push amount equal to the inbound payment minus the
on-chain fee.

More on how this works [here](https://github.com/hsjoberg/blixt-wallet/issues/242).

## Disabling channel opening

Set `"channelOpeningEnabled": false` in your config and restart Dunder to stop
it from opening any new channels. The setting is optional and defaults to `true`.
While it is disabled:

- `/ondemand-channel/register` and `/ondemand-channel/claim` return HTTP 503.
- `/ondemand-channel/service-status` reports `status: false`.
- Incoming payments for already registered channel requests are failed instead
  of settled, so payers are not charged.
- Auto-heal and the background recovery loop do not open channels. Payments
  that were already settled stay unclaimed until channel opening is enabled
  again.
- Channel opens that were already sent to lnd are still reconciled and recorded.

## Known limitations

### Fee increases after registration

Dunder enforces the configured on-chain fee ceiling when a request is registered
and again when it is ready to open the channel. During HTLC interception, however,
it currently checks only that the estimated fee leaves a positive channel push
amount. If fees rise above the configured ceiling after registration, Dunder may
therefore settle the payment and defer the channel opening until the fee estimate
falls below the ceiling. The settlement remains recorded for recovery, but the
recipient will not receive the channel immediately.

## Build

Dunder require lnd as the Lightning backend right now, though the plan is to
make the service implementation independent.

The `master` branch always expects the latest version of lnd. Lnd compiled with routerrpc is required.

1. Run lnd, wallet must be unlocked for Dunder to operate correctly
2. `git clone https://github.com/hsjoberg/dunder-lsp && cd dunder-lsp`
3. Copy `config/default.json_TEMPLATE` to `config/default.json` and set up your configuration
4. `cd src/services/admin/react-admin`
5. `npm install --legacy-peer-deps`
6. `cd ../../../../`
7. `npm install`
8. `npm run proto`
9. `npm run build`
10. `npm start`

## Running in production

### lnd settings

`store-final-htlc-resolutions` belongs in the `[Application Options]` section
of `lnd.conf`, the top section that holds most of lnd's general options (it is
in the same place in lnd's `sample-lnd.conf`). Add it under the existing
section header rather than a second one, then restart lnd:

```ini
[Application Options]
; ...your existing options...

; Lets Dunder recover the outcome of an HTLC whose settle event it missed
; (Dunder restart, stream reconnect). Without it such payments must be
; checked by hand.
store-final-htlc-resolutions=true
```

lnd only stores outcomes from the moment this is on; older HTLCs can't be
looked up.

Optional, in the `[routerrpc]` section:

```ini
[routerrpc]
; While Dunder is disconnected, fail new forwards instead of forwarding them
; unchecked, and keep HTLCs Dunder was holding so they are replayed when it
; reconnects (fewer failed on-demand payments across Dunder restarts).
; Cost: the node routes nothing while Dunder is down.
routerrpc.requireinterceptor=true
```

### Restricted macaroon

Dunder doesn't need lnd's `admin.macaroon`. Bake one limited to the RPCs it
calls and point `backendConfig.adminMacaroon` at it:

```sh
lncli bakemacaroon --save_to dunder.macaroon \
  uri:/lnrpc.Lightning/GetInfo \
  uri:/lnrpc.Lightning/EstimateFee \
  uri:/lnrpc.Lightning/NewAddress \
  uri:/lnrpc.Lightning/WalletBalance \
  uri:/lnrpc.Lightning/VerifyMessage \
  uri:/lnrpc.Lightning/ListPeers \
  uri:/lnrpc.Lightning/ListChannels \
  uri:/lnrpc.Lightning/PendingChannels \
  uri:/lnrpc.Lightning/ClosedChannels \
  uri:/lnrpc.Lightning/LookupHtlcResolution \
  uri:/lnrpc.Lightning/SubscribePeerEvents \
  uri:/lnrpc.Lightning/OpenChannelSync \
  uri:/routerrpc.Router/HtlcInterceptor \
  uri:/routerrpc.Router/SubscribeHtlcEvents
```

### Reverse proxy (HTTPS)

Dunder serves plain HTTP; put it behind a reverse proxy that terminates TLS.
Two things depend on the proxy:

- **Admin login.** When `serverDomain` starts with `https://`, the admin session
  cookie is marked `Secure` and is only set when the request arrived over HTTPS,
  which Dunder learns from the proxy's `X-Forwarded-Proto: https` header.
  Without it, admin login silently fails.
- **Per-IP rate limit.** Every request reaches Dunder from the proxy, so Dunder
  sees the proxy's address as the client. `trustProxy` tells Dunder which
  addresses are your proxy; for requests from those, it takes the real client
  address from the `X-Forwarded-For` header instead. Without it, all clients
  share one limit (`ipRateLimitPerMinute`), and a busy or abusive client blocks
  everyone. Requests from other addresses are never trusted, so clients can't
  pick their own address with a forged header.

**Caddy** sends both headers by default (`X-Forwarded-Proto`, and
`X-Forwarded-For` with the real client address, ignoring any value the client
sent), and proxies the admin WebSocket without extra configuration:

```caddyfile
dunder.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

With Caddy on the same machine, set in Dunder's config:

```json
"serverDomain": "https://dunder.example.com",
"serverHost": "127.0.0.1:8080",
"trustProxy": "loopback"
```

`loopback` trusts 127.0.0.1 and ::1 (Caddy may connect over either). If the
proxy runs elsewhere, list its address instead (`"trustProxy": "10.0.0.5"`).
Binding `serverHost` to 127.0.0.1 keeps Dunder reachable only through the proxy.
`serverDomain` must be the address wallets use: Blixt signs requests for that
host and Dunder rejects requests signed for another.

**nginx** doesn't send these by default; add
`proxy_set_header X-Forwarded-Proto $scheme;` and
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, plus the usual
WebSocket upgrade headers for `/admin/api/login-ws`.

### Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `htlcWaitSeconds` | 60 | How long the parts of a multi-part payment are held while waiting for the rest. Replaces `htlcWaitMs`, which was always read as seconds. |
| `allowLegacySignatures` | `true` | Accept wallet requests signed with the old fixed words (`REGISTER`, `CLAIM`, `CHECKSTATUS`). Turn off once wallets use signed messages. |
| `maxOpenRequestsPerPubkey` | 5 | Unpaid, unexpired requests a wallet may have at once. |
| `signedRequestRateLimitPerMinute` | 30 | Signed wallet requests accepted per pubkey per minute. |
| `ipRateLimitPerMinute` | 120 | Requests to the public API (`/ondemand-channel/*`, `/getInfo`, `/estimateFee`) per client IP per minute. `0` turns it off. |
| `trustProxy` | `false` | Addresses of your reverse proxy, whose `X-Forwarded-For` gives the real client address (e.g. `"loopback"`, `"10.0.0.5"`, a hop count, or `true` for any). **Set this when running behind a proxy**; see "Reverse proxy (HTTPS)". |

### Signed wallet requests

`/ondemand-channel/register`, `/claim` and `/check-status` take a body of

```json
{ "pubkey": "<hex, optional>", "message": "<signed JSON text>", "signature": "<lnd SignMessage signature>" }
```

where `message` is the exact JSON text that was signed:

```json
{
  "endpoint": "/ondemand-channel/register",
  "domain": "<host of Dunder's serverDomain>",
  "timestamp": 1731628800,
  "nonce": "<random string, 8-128 characters>",
  "data": { "amountSat": 50000, "preimage": "<64 hex characters>" }
}
```

Request fields are read from `data` (`claim` and `check-status` have none). A
message is accepted within 30 seconds of its timestamp and only once.
`domain` must match the host of Dunder's `serverDomain`, so wallets must reach
Dunder under that name. `/ondemand-channel/service-status` returns
`"requestSigningVersion": 2` so wallets know they can use this format. Version
1, signing only a fixed word, is what older Dunder servers accept.

# Admin interface

<div>
  <img src="admin-interface.webp" />
</div>

The admin interface is reachable via `/admin`.

To create an administrator, run `scripts/create-admin-lnurl-auth.js` and scan the QR-code with an
LNURL-auth compatible wallet (for example [Blixt Wallet](https://blixtwallet.github.io)):

`node scripts/create-admin-lnurl-auth.js <listen host:ip> <domain/IP to reach from)> <HTTPS (true/false)>`

This will create a temporary HTTP server serving an LNURL-auth endpoint at /lnurl-auth.

# Regtest integration tests

`regtest/` runs Dunder against real lnd nodes (lnd v0.21.8) on a local regtest
network in Docker:

```
payer --(public channel)--> lsp --(Dunder opens on demand)--> wallet
```

`lsp` is Dunder's node, `wallet` plays the Blixt wallet and `payer` pays the
invoices. Dunder itself runs inside the test process, with zero-conf channels
off as in production, so each payout channel is confirmed by mining blocks.

```sh
npm run regtest:up      # start bitcoind + 3 lnd nodes, fund them, open payer -> lsp
npm run regtest:test    # run the scenarios in regtest/dunder.regtest.ts
npm run regtest:down    # stop everything and delete regtest/.data

npm run regtest -- status               # pubkeys, balances, channels
npm run regtest -- mine 6               # mine blocks
npm run regtest -- lncli lsp listchannels
```

The scenarios cover: a single-part and a multi-part payment paid out in a new
channel, a probe with a wrong payment hash (fails, interceptor stays up), a
payment above the registered amount (`unknown_next_peer`), a payment while the
wallet is offline, and the legacy signature format. Requires Docker; gRPC ports
20009-20011 are bound to localhost.

Note: after a payment fails at Dunder's hop, the payer's lnd avoids that route
for a while (mission control), so a wallet that probes before paying gets "no
route" for the real payment. The tests reset the payer's mission control
between scenarios.

# Test

To do tests run `npm run test` or `npm run test:coverage`.

Any new code should not decerease code coverage significantly.

## License

MIT
