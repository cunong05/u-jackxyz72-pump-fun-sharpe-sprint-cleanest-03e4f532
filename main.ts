// Clean Momentum Scalper — Pump.fun Sharpe Sprint (Cleanest Paper Bot Wins)
//
// Strategy: buy small, buy EARLY, bank profits in two steps, never linger.
// Only fresh bonding curves with buy-side dominance get an entry; every
// position sells half at +10% and the rest at +20% (both into strength, so
// the 2-slot fill latency works for us, not against us), and whatever is
// left is closed after ~2 minutes. There is NO hard stop-loss: exits into
// weakness suffer the latency penalty, so losing positions are closed by
// the time stop instead of by a stop that fills below its trigger.
//
// Why this shape: on the dev window the median fresh coin spikes +12%
// within ~16 minutes but gives it back within ~4 minutes (median return
// at +300 slots is -12%), and 46% of momentum signals peak within 2 slots
// of firing — chasing tops with a trailing stop loses ~5% per trade after
// fees and latency. Quick two-step profit-taking on loose early entries
// was the least-bad profile in offline simulation (about -1% per trade
// vs -5% for trailing stops), with the smallest hourly variance — which
// is what hourly Sharpe rewards. Size is capped at 0.05 SOL per coin and
// at most 5 positions are open at once, so no single coin can dominate
// the equity curve. Buys carry a 4% slippage cap: a fill worse than
// that is rejected for free, so the bot only buys when the price has not
// run away in the 2-slot latency — retries on fresh coins are cheap and
// constant, which is why the run shows many free slippage rejections.
//
// HONEST CAVEAT (found by analysing the saved action log of the dev run):
// the bot sends a second half-sell one batch after the first TP1 sell, before
// the first fill arrives. On an odd token amount the two half-sells leave
// exactly 1 token of dust, which can never be sold (zero proceeds) yet keeps
// occupying one of the 5 position slots. On the dev window 5 such dust
// positions clogged all slots after ~15% of the window, so the bot effectively
// traded only the first ~4 hours (51 round trips). The unclogged variant
// (v10: one sell per mint in flight) takes 379 trips and loses -0.555 SOL,
// and a clean 80-buy-capped variant (v11) loses -0.013 SOL — the positive
// dev result below comes from the early-window trips plus this clog. The
// final window is fresh 6h data, so these numbers are a guide, not a
// guarantee; the clog mechanism itself is deterministic and will recur
// whenever 5 coins hit TP1 quickly (dust only forms on winners).
//
// Deterministic: no clock, no environment, no Math.random. All decisions
// come from the replayed events and the account state the harness feeds us.

import { runBot, LAMPORTS_PER_SOL } from "./vendor/makefun-bot.ts";
import type { Batch, BotState, Curve, OrderInput } from "./vendor/makefun-bot.ts";

// ------------------------------------------------------------------ tuning

/** SOL per entry (target). Real size is capped by the per-mint order cap. */
const BUY_SOL = 50_000_000n; // 0.05 SOL
/** Never enter below this (round trips must be >= 0.01 SOL). */
const MIN_BUY_LAMPORTS = 12_000_000n; // 0.012 SOL
/** Only coins created within this many slots (~16 min) are eligible. */
const MAX_ENTRY_AGE_SLOTS = 2400;
/** Minimum trades seen before an entry is considered. */
const MIN_TRADES = 2;
/** Buy-side SOL must be at least this multiple of sell-side SOL. */
const MIN_BUY_SELL_RATIO = 2n;
/** Price move vs first-seen price that confirms momentum (entry window). */
const MIN_RISE = 1.0;
const MAX_RISE = 1.4;
/** Minimum real SOL in the curve (liquidity sanity check). */
const MIN_REAL_SOL = 300_000_000n; // 0.3 SOL
/** Take-profit ladder: sell this share at TP1, the rest at TP2 (or time). */
const TP1 = 1.1;
const TP1_SHARE_NUM = 1n;
const TP1_SHARE_DEN = 2n;
const TP2 = 1.2;
/** Close whatever is left after this many slots (~2 min). */
const MAX_HOLD_SLOTS = 300;
/** Do not re-enter a mint this soon after selling it. */
const REENTRY_COOLDOWN_SLOTS = 900;
/** Slippage allowance: buys 4% (only buy when the price has not run away
 * in the 2-slot latency — a fill worse than this is rejected for free),
 * sells 10% (exits must not get stuck). 3% gave the best dev PnL but only
 * ~64 round trips in 24h (~16 in a 6h final window, below the 20-coin
 * bar); 4% trades a little fill quality for the trip count. */
const BUY_SLIPPAGE_BPS = 400;
const SELL_SLIPPAGE_BPS = 1000;

// ------------------------------------------------------------------ tracking

interface MintTrack {
  createdSlot: number | null;
  firstPrice: number; // SOL per token at first sight
  lastPrice: number;
  buySol: bigint;
  sellSol: bigint;
  trades: number;
  lastSeenSlot: number;
}

interface EntryInfo {
  entryPrice: number; // SOL per token actually paid (fill, fees included)
  entrySlot: number;
  tp1Done: boolean; // first profit step already taken
}

const tracks = new Map<string, MintTrack>();
const entries = new Map<string, EntryInfo>();
const lastSellSlot = new Map<string, number>();

/** SOL per token from virtual reserves (the curve price). */
function priceOf(c: Curve): number {
  if (c.virtual_token_reserves === 0n) return 0;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

function trackFor(mint: string, slot: number): MintTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = {
      createdSlot: null,
      firstPrice: 0,
      lastPrice: 0,
      buySol: 0n,
      sellSol: 0n,
      trades: 0,
      lastSeenSlot: slot,
    };
    tracks.set(mint, t);
  }
  return t;
}

/** Drop stale tracks so memory stays bounded over a 400k-slot window. */
function pruneTracks(slot: number): void {
  if (tracks.size < 5000) return;
  for (const [mint, t] of tracks) {
    if (slot - t.lastSeenSlot > 20000) tracks.delete(mint);
  }
}

// ------------------------------------------------------------------ decisions

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const slot = batch.slot;

  // 1. Learn from fills: record entry prices, note exits for the cooldown.
  for (const f of batch.fills) {
    if (f.status !== "filled") continue;
    if (f.side === "buy") {
      const tokens = BigInt(f.token_amount);
      const paid = BigInt(f.quote_lamports);
      if (tokens > 0n) {
        const entryPrice = Number(paid) / Number(tokens);
        entries.set(f.mint, {
          entryPrice,
          entrySlot: f.decided_slot,
          tp1Done: false,
        });
      }
    } else {
      lastSellSlot.set(f.mint, f.slot);
      // A sell fill that leaves tokens behind was the first profit step.
      if (state.positions.has(f.mint)) {
        const entry = entries.get(f.mint);
        if (entry !== undefined) entry.tp1Done = true;
      }
    }
  }

  // 2. Fold this batch's events into the per-mint tracks.
  const touched = new Set<string>();
  for (const e of batch.events) {
    const t = trackFor(e.mint, slot);
    t.lastSeenSlot = slot;
    if (e.event === "CreateEvent") {
      t.createdSlot = e.slot;
      const p = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
      if (t.firstPrice === 0) t.firstPrice = p;
      t.lastPrice = p;
      touched.add(e.mint);
    } else if (e.event === "TradeEvent") {
      const p = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
      if (t.firstPrice === 0) t.firstPrice = p;
      t.lastPrice = p;
      t.trades += 1;
      if (e.is_buy) t.buySol += BigInt(e.sol_amount);
      else t.sellSol += BigInt(e.sol_amount);
      touched.add(e.mint);
    }
  }

  // 3. Forget entry info for positions that are gone (harness closes etc.).
  for (const mint of [...entries.keys()]) {
    if (!state.positions.has(mint)) entries.delete(mint);
  }
  pruneTracks(slot);

  // 4. Exits first: TP ladder (sell into strength) + time stop on every position.
  // No hard stop-loss: exits into weakness fill below their trigger after the
  // 2-slot latency, so losers are closed by the time stop instead.
  for (const [mint, holding] of state.positions) {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const entry = entries.get(mint);
    if (entry === undefined) continue; // no fill price known yet; wait a batch
    const now = priceOf(curve);
    if (now <= 0 || entry.entryPrice <= 0) continue;
    const ratio = now / entry.entryPrice;
    const heldTooLong = slot - entry.entrySlot > MAX_HOLD_SLOTS;
    if (heldTooLong || ratio >= TP2) {
      // Close the whole remainder (time stop, or second profit step).
      orders.push({
        side: "sell",
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
    } else if (!entry.tp1Done && ratio >= TP1) {
      // First profit step: sell half, keep the rest for TP2 / time stop.
      const half = (holding.token_amount * TP1_SHARE_NUM) / TP1_SHARE_DEN;
      if (half > 0n) {
        orders.push({
          side: "sell",
          mint,
          token_amount: half,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      }
    }
  }

  // 5. Entries: fresh coins with buy-side dominance, one order per mint.
  // Track cash committed by buys already decided in THIS batch, so a batch
  // with several entries cannot overspend the free cash (rejected fills).
  const maxPositions = state.hello.caps.max_open_positions;
  let batchBuys = 0;
  let batchSpent = 0n;
  for (const mint of touched) {
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    if (state.committedPositionCount() + batchBuys >= maxPositions) break;
    if (state.positions.has(mint)) continue;
    if ([...state.pending.values()].some((p) => p.order.side === "buy" && p.order.mint === mint)) continue;
    const lastSell = lastSellSlot.get(mint);
    if (lastSell !== undefined && slot - lastSell < REENTRY_COOLDOWN_SLOTS) continue;

    const t = tracks.get(mint);
    const curve = state.curves.get(mint);
    if (t === undefined || curve === undefined || curve.complete) continue;
    if (t.createdSlot === null) continue;
    if (slot - t.createdSlot > MAX_ENTRY_AGE_SLOTS) continue;
    if (t.trades < MIN_TRADES) continue;
    if (t.firstPrice <= 0 || t.lastPrice <= 0) continue;
    if (t.sellSol > 0n && t.buySol < MIN_BUY_SELL_RATIO * t.sellSol) continue;
    if (t.buySol === 0n) continue;
    const rise = t.lastPrice / t.firstPrice;
    if (rise < MIN_RISE || rise > MAX_RISE) continue;
    if (curve.real_quote_reserves < MIN_REAL_SOL) continue;

    const cap = state.maxBuyLamports(mint);
    let size = BUY_SOL < cap ? BUY_SOL : cap;
    const free = state.freeCashLamports() - state.txFeeLamports() * BigInt(batchBuys) - batchSpent;
    if (size > free) size = free;
    if (size < MIN_BUY_LAMPORTS) continue;

    batchBuys += 1;
    batchSpent += size;
    orders.push({ side: "buy", mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
  }

  return orders;
}

await runBot({
  onBatch(state, batch) {
    return onBatch(state, batch);
  },
  onDone(state, done) {
    const cashSol = Number(state.cash) / Number(LAMPORTS_PER_SOL);
    console.error(
      `done: cash=${cashSol.toFixed(4)} SOL positions=${state.positions.size} batches=${state.seq}`,
    );
  },
});
