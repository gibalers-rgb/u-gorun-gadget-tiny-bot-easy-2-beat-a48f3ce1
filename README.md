# Snapback Rotation — Tiny Solana Paper-Trading Bot

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/gibalers-rgb/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/gibalers-rgb/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny paper-trading bot for the make.fun bounty **Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana**. It reads hourly bars over the `agent-fun/bars-replay/v1` line protocol and only holds coins while their short trend points up — otherwise it sits in USDC.

## Strategy

- **Trend ride:** buy 20% of equity when a coin's 12h average is above its 48h average, its 12h return is over +0.5%, and its 6h return is positive. Exit when the averages cross back, on a 3% stop-loss, when the 12h return drops below −2%, or on a trailing stop (armed at +4%, sells on a 2% pullback).
- **Rotation:** every 12 bars, take the coin with the best 24h return (unless it is down more than 2%) with a 15% slice, and let it go after 12 bars at the latest.
- **Safety rails:** 2-bar cooldown after selling a coin; if equity falls 6% below its peak, everything is flattened and the bot stays out for 12 bars.

## Run

```sh
node main.ts
```

The bot speaks the `agent-fun/bars-replay/v1` protocol on stdin/stdout, needs no network, no files, and no secrets. Grade it locally with the kit's CLI:

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

## License

MIT — see [LICENSE](LICENSE).
