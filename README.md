# 💥 Dunder LSP

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

1. Run lnd, wallet must be unlocked for Dunder to operate correctly
2. `git clone https://github.com/hsjoberg/dunder-lsp && cd dunder-lsp`
3. Copy `config/default.json_TEMPLATE` to `config/default.json` and set up your configuration
4. `yarn`
5. `yarn start`

## Why does every local import include the file extension (.js)?

This is the only way I could get NodeJS to work with ES6 modules,
which is required for top-level await support.

# LICENSE

MIT
