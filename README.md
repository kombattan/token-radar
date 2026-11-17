# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/kombattan/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/kombattan/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar over the sealed DefiLlama snapshot: every protocol that records no token, ranked by implied value. Each pre-token protocol is priced by a model fitted to the snapshot's own tokenized protocols: a least-squares curve of market cap over TVL (value grows at about the square root of size), a per-category offset shrunk by peer count, and fitted adjustments for seven-day TVL momentum, chain breadth and tokenless age. The board covers all 40 watchlist protocols and adds 159 further pre-token finds beyond it, each with a concrete eight-step farm plan (wallet setup, the category's core action, position sizing against its own TVL, cadence, honest gas costs on its own chain, and the exit) derived from its category, chains, TVL and age. The dashboard is a static page with no network: a searchable, sortable, filterable board, a per-protocol detail view that recomputes the row's implied value in the page from the fitted parameters, the category's tokenized peers, and the full methodology with every fitted parameter printed, a log-log chart of the peers and board rows against the fitted curve, and a sensitivity comparison against flat median-multiple pricing, and an out-of-sample holdout test: the peer set is split by a hash of each peer's slug, the model is refitted on the training peers alone, and its prices for the held-out peers are scored against the market caps they actually carry (rank correlation and a top-quartile hit rate), printed next to the same numbers computed in-sample so the optimism gap is visible rather than hidden.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=kombat-tan&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
