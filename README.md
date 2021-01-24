# Dunder LSP

Dunder is a Lightning Service Provider for the Bitcoin Lightning Network.

It currently supports "on demand channel openings", meaning if a Lightning wallet
gets an inbound payment while not having any inbound capacity, Dunder will open
a channel to the wallet with push amount equal to the inbound payment minus the
on-chain fee.

More on how this works [here](https://github.com/hsjoberg/blixt-wallet/issues/242).

## Build

Dunder require lnd as the Lightning backend right now, though the plan is to
make the service implementation independent.

Dunder expects lnd dir to be in `<home>/.lnd`.

The `master` branch always expects the latest version of lnd.

1. Install and run lnd
2. `yarn`
3. `DUNDER_HOST=<ip:port> LND_NODE=<ip:port> yarn start`

# LICENSE

MIT
