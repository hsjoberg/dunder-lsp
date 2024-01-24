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

## Dunder's API

The API endpoints supplied by dunder LSP are:

- /estimateFee - returns estimated fee (sats) and fee rate (sats per byte)

- /getInfo - returns info from lnd, see https://github.com/hsjoberg/dunder-lsp/blob/master/proto/rpc.proto#L1596 and look for GetInfoReponse to understand the returned data. Exact line numbers may vary.

- /ondemand-channel
    - /check-status - checks validity and sats claimable.
    - /claim - rarely neded. Used to check status of a request in case /register does not succeed to give full feedback.
    - /register - registers a channel request and takes care of opening the channel to the user. Then dunder will push the amount into a new channel.
    - /service-status - returns status (boolean), minimum and maximum payment accepted, current fee estimate, and peer.

## Build

Dunder requires lnd as the Lightning backend right now, though the plan is to
make the service implementation independent.

The `master` branch always expects the latest version of lnd, which must be compiled with routerrpc enabled.

1. Run lnd. The wallet must be unlocked for Dunder to operate correctly.
2. `git clone https://github.com/hsjoberg/dunder-lsp && cd dunder-lsp`
3. Copy `config/default.json_TEMPLATE` to `config/default.json` and set up your configuration
4. `cd src/services/admin/react-admin`
5. `npm install --legacy-peer-deps`
6. `cd ../../../../`
7. `npm install`
8. `npm run proto`
9. `npm run build`
10. `npm start`

# Admin interface

<div>
  <img src="admin-interface.webp" />
</div>

The admin interface is reachable via `/admin`.

To create an administrator, run `scripts/create-admin-lnurl-auth.js` and scan the QR-code with an
LNURL-auth compatible wallet (for example [Blixt Wallet](https://blixtwallet.github.io)):

`node scripts/create-admin-lnurl-auth.js <listen host:ip> <domain/IP to reach from)> <HTTPS (true/false)>`

This will create a temporary HTTP server serving an LNURL-auth endpoint at /lnurl-auth.

# Test

To do tests run `npm run test` or `npm run test:coverage`.

Any new code should not decerease code coverage significantly.

## License

MIT
