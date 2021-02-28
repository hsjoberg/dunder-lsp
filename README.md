# 💥 Dunder LSP

_Work In Progress, not suited for production just yet._  
_Contributions, suggestions and ideas are appreciated._

Dunder is a Lightning Service Provider for the Bitcoin Lightning Network.

It currently supports "on demand channel openings", meaning if a Lightning wallet
gets an inbound payment while not having any inbound capacity, Dunder will open
a channel to the wallet with push amount equal to the inbound payment minus the
on-chain fee.

More on how this works [here](https://github.com/hsjoberg/blixt-wallet/issues/242).

## Dunder's API

The API endpoints supplied by dunder LSP are:

- /estimateFee - returns estimated fee (sats) and fee rate (sats per byte)

- /getInfo - returns info from lnd - for details, see https://github.com/LN-Zap/node-lnd-grpc/blob/master/proto/0.12.0-beta/lnrpc/rpc.proto#L1567

- /ondemand-channel
    - /check-status - checks validity and sats claimable.
    - /claim - asks dunder to push the clamiable amount (minus fees) into a new channel.
    - /register - registers a blixt wallet with dunder. Necessary to use claim below.
    - /service-status - returns status (boolean), minimum and maximum payment accepted, current fee estimate, and peer.

## Build

Dunder requires lnd as the Lightning backend right now, though the plan is to
make the service implementation independent.

The `master` branch always expects the latest version of lnd, which must be compiled with routerrpc enabled.

1. Run lnd. The wallet must be unlocked for Dunder to operate correctly.
2. `git clone https://github.com/hsjoberg/dunder-lsp && cd dunder-lsp`
3. Copy `config/default.json_TEMPLATE` to `config/default.json` and set up your configuration
4. `yarn`
5. `yarn start`

# Test

To do tests run `yarn test` or `yarn test:coverage`.

Any new code should not decerease code coverage significantly.

## License

MIT
