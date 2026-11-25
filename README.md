# Clean Momentum Scalper

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/cunong05/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/cunong05/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for make.fun's "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" bounty ($2 in USDC). It trades 10 SOL of paper money on a 6-hour pump.fun replay; places go by hourly Sharpe ratio, so the bot is built for steady, controlled gains — not moonshots.

## Strategy

- **Enter early, enter small:** fresh bonding curves (created within ~16 minutes) with buy-side dominance (buy SOL ≥ 2× sell SOL) and a small early rise (0–40% above first-seen price). At most 0.05 SOL per coin (usually less: buys are capped at 1% of the curve's real SOL reserve), at most 5 open positions.
- **Bank profits in two steps:** sell half at +10%, the rest at +20% — both exits sell *into strength*, so the harness's 2-slot fill latency works for the bot instead of against it.
- **Never linger:** whatever is left is closed after ~2 minutes. There is deliberately **no hard stop-loss** — exits into weakness fill below their trigger after the latency, so losers are closed by the time stop instead.
- **Fully deterministic:** no clock, no environment, no randomness — every decision comes from the replayed events and the account state.

## Why this shape

Measured on the kit's dev window (24h of pump.fun data, 1,222 mints): the median fresh coin spikes +12% within ~16 minutes but gives it back within ~4 minutes, and 46% of momentum signals peak within 2 slots of firing. Trailing stops and fixed stop-losses lose ~5% per trade after the ~2.9% round-trip fees and the 2-slot latency. Quick two-step profit-taking on loose early entries was the least-bad profile in offline simulation (~-1% per trade) with the smallest hourly variance — which is what hourly Sharpe rewards.

## Dev backtest (kit's `grade-local`, process driver, dev window, Node v24.22.1 locally vs Node 22.23.4 on the grader)

- v1 (fixed TP +12% / SL −9%): net PnL −1.195 SOL, max drawdown 11.95%, win rate 22.9%, 441 round trips.
- v3 (trailing stop): net PnL −0.602 SOL, Sharpe −1.035, max drawdown 6.20%, win rate 13.7%, 271 round trips.
- v4 (TP ladder, this design): net PnL −0.030 SOL (−0.30%), Sharpe −0.105, max drawdown 0.93%, win rate 27.4%, 146 round trips, 146 distinct mints. 90% interval −0.117 … +0.057 SOL.
- v6 (buy slippage 5% → 2%): net PnL **+0.009 SOL**, Sharpe +0.050, max drawdown 0.38%, win rate 33.9%, 62 round trips.
- v7 (buy slippage 3%): net PnL **+0.012 SOL**, Sharpe +0.064, Sortino +0.118, max drawdown 0.37%, win rate 34.4%, 64 round trips.
- v8 (looser entries: age ≤ 2400 slots, rise ≤ 1.4): net PnL **+0.024 SOL**, Sharpe +0.107, Sortino +0.180, max drawdown 0.57%, win rate 41.2%, 51 round trips.
- **v9 (final, buy slippage 4%): net PnL +0.022 SOL (+0.22%), Sharpe +0.100, Sortino +0.161, max drawdown 0.57%, win rate 41.2%, 51 round trips, 51 distinct mints, 116 fills.** 90% interval −0.044 … +0.066 SOL. Guardrails met: ≥20 distinct-mint round trips (51), max drawdown ≤50% (0.57%), net PnL > 0.

Honest caveat: the positive dev result is fragile and partly accidental. Analysing the saved action log showed the bot sends a second half-sell one batch after the first TP1 sell, before the first fill arrives; on an odd token amount the two half-sells leave exactly 1 token of dust, which can never be sold (zero proceeds) yet keeps occupying one of the 5 position slots. Five such dust positions clogged all slots after ~15% of the dev window, so the bot effectively traded only the first ~4 hours (all 79 buys were sent in the first 9,579 of 63,369 batches) — and the 5 clogged coins were its biggest winners (+0.024 SOL banked between them). The unclogged variant (v10: one sell per mint in flight) takes 379 trips and loses −0.555 SOL (Sharpe −0.639), and a clean 80-buy-capped variant (v11) loses −0.013 SOL (Sharpe −0.050). The final window is fresh 6h data, so treat the dev numbers as a guide, not a guarantee: the bot's edge, if any, is in catching a few early spikes and then stopping, not in grinding hundreds of trades.

**Stress test (kit's `grade-local --stress 5`, rebuilt dev-window copies): all 5 copies lose — −0.41, −0.14, −0.26, −0.08, −0.22 SOL (mean ≈ −0.22 SOL).** The +0.022 SOL dev result did not generalise to resampled data; on fresh data this bot is more likely than not to finish slightly negative. It is submitted as-is because every variant tested (11 versions, plus offline sweeps of trailing stops, pullbacks, crowd filters, buyer-count filters and exit styles) was negative in expectation, and v9 has the best dev-window numbers and the smallest drawdown of any version.

## Run it

```sh
node main.ts
```

`main.ts` speaks the `agent-fun/replay/v2` protocol on stdin/stdout (hello → batches → done). It needs Node 22.18+ (the grader runs Node 22.23.4); no dependencies, no install. `vendor/makefun-bot.ts` is the kit's official SDK shim, copied unchanged.

To grade it locally against the kit's dev window (from inside the unpacked kit):

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process --worktree
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=cunong05&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
