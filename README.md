# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/kombattan/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/kombattan/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar over the sealed DefiLlama snapshot: every protocol that records no token, ranked by implied value. Each pre-token protocol is priced off the tokenized peers in its own category — TVL times the category's median market-cap-to-TVL ratio (shrunk toward the market-wide median by sample size and winsorized), adjusted for seven-day TVL growth and for how long the protocol has run with no token. The board covers all 40 watchlist protocols and adds 158 further pre-token finds beyond it, each with a concrete farm plan (action, cost, time) derived from its category, chains, TVL and age. The dashboard is a static page with no network: a sortable, filterable board, a per-protocol detail view that recomputes the row's implied value in the page, and the live-token peers set aside at the market's own values.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=kombat-tan&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
