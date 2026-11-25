// Snapback Rotation — a tiny paper-trading bot for agent-fun/bars-replay/v1.
//
// Idea: in a market where every symbol can fall together, buy-and-hold bleeds.
// This bot only holds coins while their short trend points up, and otherwise sits
// in cash. Two independent ways in, both with a hard exit:
//
//  1. Trend ride. When a coin's 12-hour average price sits above its 48-hour
//     average, its 12-hour return is positive and its 6-hour return is positive
//     too, buy a 20%-of-equity slice. The ride ends when the averages cross back,
//     when the price drops 3% under what we paid, when the 12-hour return turns
//     clearly negative, or when a trailing stop (set once we are up 4%) is hit.
//
//  2. Rotation. Every 12 bars, if no trend ride is open on it, take the coin with
//     the best 24-hour return — provided it is not in free fall (worse than -2%)
//     and not sliding downhill (its fast average must sit above its slow one, or
//     its 6-hour return must already be positive) — with a 15% slice, and let it
//     go after 12 bars at the latest.
//
// Safety rails: after a sale, the same coin rests 2 bars before it can be bought
// again; if equity ever falls 6% below its peak, everything is flattened and the
// bot stays out for 12 bars. No clock, no randomness, no network, no files —
// every decision comes from the bars the harness sends, so two runs agree exactly.
//
// Money is kept as bigints in USDC raw units (6 decimals); prices are plain
// numbers (USDC per coin) used only for signals and stops.

import { createInterface } from "node:readline";

// --- tunables (picked by backtesting the kit's dev window) -----------------
const FAST_SPAN = 12; // hours in the fast average
const SLOW_SPAN = 48; // hours in the slow average
const MIN_HISTORY_BARS = 24; // bars of closes before the first trade
const TREND_SIZE_BPS = 2000; // 20% of equity per trend ride
const ROT_SIZE_BPS = 1500; // 15% of equity per rotation ride
const ROT_EVERY_BARS = 12; // rotation clock
const ROT_HOLD_BARS = 12; // longest a rotation ride lasts
const ROT_MIN_RETURN_24H = -0.02; // never rotate into a coin down >2% in 24h
const ENTRY_RETURN_12H = 0.005; // trend ride needs +0.5% over 12h
const EXIT_RETURN_12H = -0.02; // trend ride ends at -2% over 12h
const STOP_LOSS = 0.03; // sell 3% under the average price we paid
const TRAIL_GAIN = 0.04; // arm the trailing stop once up 4%
const TRAIL_BACK = 0.02; // ... then sell on a 2% pullback from the high
const COOLDOWN_BARS = 2; // rest after selling a coin before re-buying it
const GUARD_REST_BARS = 12; // bars to stay out after the guard fires
const MAX_SLIPPAGE_BPS = 300; // headroom for hourly gaps at the next open
const BPS = 10000n;

type Bar = {
  symbol: string;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string | null;
  o_depth: string[];
  c_depth: string[];
};

type Position = { symbol: string; qty: string; cost_quote_units: string };

type Account = {
  cash_quote_units: string;
  positions: Position[];
  equity_quote_units: string;
};

type HelloSymbol = {
  symbol: string;
  mint: string;
  price_scale: number;
  qty_scale: number;
};

type Hello = {
  type: "hello";
  protocol: string;
  seed: string;
  symbols: HelloSymbol[];
  capital: { quote: string; quote_scale: number; quote_units: string };
  bar_interval: string;
  first_close_ms: number;
  caps: {
    max_open_positions: number;
    max_orders_per_bar: number;
    max_weight_bps: number;
    shorts: boolean;
    leverage: boolean;
  };
  fees: { fee_bps: number; slippage_bps: number; min_notional_quote_units: string };
  latency_bars: number;
  warmup_bars?: number;
};

type Batch = {
  type: "batch";
  seq: number;
  t: number;
  bars: Bar[];
  fills: unknown[];
  account: Account;
};

type Order =
  | {
      side: "buy";
      client_id: string;
      symbol: string;
      notional_quote_units: string;
      max_slippage_bps: number;
    }
  | {
      side: "sell";
      client_id: string;
      symbol: string;
      qty: string;
      max_slippage_bps: number;
    };

type CoinState = {
  closes: number[]; // close prices, USDC per coin, oldest first
  emaFast: number | null;
  emaSlow: number | null;
  lastSellBar: number; // bar index of the last sale, for the cooldown
  bornBar: number | null; // bar index a rotation ride was opened on
  isRotation: boolean; // true while the open ride came from the rotation
  trail: number | null; // armed trailing-stop level, USDC, or null
};

const coins = new Map<string, CoinState>();
const scales = new Map<string, { price: number; qty: number }>();
let hello: Hello | null = null;
let barsSeen = 0;
let peakEquity = 0n;
let guardUntilBar = -1;
let orderCounter = 1;

function coinState(symbol: string): CoinState {
  let s = coins.get(symbol);
  if (!s) {
    s = {
      closes: [],
      emaFast: null,
      emaSlow: null,
      lastSellBar: -1000000,
      bornBar: null,
      isRotation: false,
      trail: null,
    };
    coins.set(symbol, s);
  }
  return s;
}

/** Price of a raw integer at its scale, as a plain number. */
function toPrice(raw: string, scale: number): number {
  return Number(BigInt(raw)) / 10 ** scale;
}

/** Return over the last `n` bars, or null when there is not enough history. */
function retOver(s: CoinState, n: number): number | null {
  const c = s.closes;
  if (c.length <= n) return null;
  const now = c[c.length - 1];
  const then = c[c.length - 1 - n];
  if (then <= 0) return null;
  return now / then - 1;
}

/** Average price actually paid for a position, in USDC per coin. */
function avgCost(p: Position): number {
  const sc = scales.get(p.symbol);
  if (!sc) return 0;
  const qtyUnits = Number(BigInt(p.qty)) / 10 ** sc.qty;
  if (qtyUnits <= 0) return 0;
  const costUsdc = Number(BigInt(p.cost_quote_units)) / 10 ** hello!.capital.quote_scale;
  return costUsdc / qtyUnits;
}

/** What `qty` raw units of a coin are worth at `priceRaw`, in USDC raw units. */
function valueRaw(symbol: string, qtyRaw: bigint, priceRaw: bigint): bigint {
  const sc = scales.get(symbol);
  if (!sc || !hello) return 0n;
  return (
    (qtyRaw * priceRaw * 10n ** BigInt(hello.capital.quote_scale)) /
    10n ** BigInt(sc.qty + sc.price)
  );
}

function nextClientId(): string {
  return `t${orderCounter++}`;
}

function decide(batch: Batch): Order[] {
  const orders: Order[] = [];
  if (!hello) return orders;
  const account = batch.account;
  const cash = BigInt(account.cash_quote_units);
  const equity = BigInt(account.equity_quote_units);
  if (equity > peakEquity) peakEquity = equity;
  const barIdx = barsSeen;
  const warmingUp = (hello.warmup_bars ?? 0) > 0 && batch.seq < (hello.warmup_bars ?? 0);
  const ready = barIdx >= MIN_HISTORY_BARS && !warmingUp;

  const held = new Map<string, Position>();
  for (const p of account.positions) held.set(p.symbol, p);

  // --- fold this batch's bars into the per-coin history -------------------
  const closeBySymbol = new Map<string, number>();
  const closeRawBySymbol = new Map<string, bigint>();
  for (const b of batch.bars) {
    const sc = scales.get(b.symbol);
    if (!sc) continue;
    const price = toPrice(b.c, sc.price);
    const st = coinState(b.symbol);
    st.closes.push(price);
    const kF = 2 / (FAST_SPAN + 1);
    const kS = 2 / (SLOW_SPAN + 1);
    st.emaFast = st.emaFast === null ? price : price * kF + st.emaFast * (1 - kF);
    st.emaSlow = st.emaSlow === null ? price : price * kS + st.emaSlow * (1 - kS);
    closeBySymbol.set(b.symbol, price);
    closeRawBySymbol.set(b.symbol, BigInt(b.c));
  }

  // --- guard: flatten everything on a deep equity dip ---------------------
  // Exact integer math: trip when equity is under 94% of its peak.
  const guardHit =
    ready && peakEquity > 0n && equity < (peakEquity * 94n) / 100n;
  if (guardHit) guardUntilBar = barIdx + GUARD_REST_BARS;

  let cashLeft = cash;

  // --- exits ---------------------------------------------------------------
  for (const [symbol, p] of held) {
    const st = coinState(symbol);
    const close = closeBySymbol.get(symbol);
    if (close === undefined || st.emaFast === null || st.emaSlow === null) continue;
    const cost = avgCost(p);
    const r12 = retOver(st, 12);
    let leave = false;
    if (st.emaFast < st.emaSlow) leave = true; // trend turned
    if (cost > 0 && close < cost * (1 - STOP_LOSS)) leave = true; // stop loss
    if (r12 !== null && r12 < EXIT_RETURN_12H) leave = true; // momentum died
    if (st.isRotation && st.bornBar !== null && barIdx - st.bornBar >= ROT_HOLD_BARS) {
      leave = true; // rotation ride ran its course
    }
    // Trailing stop: once up TRAIL_GAIN, keep 1 - TRAIL_BACK of the best close.
    if (cost > 0 && close > cost * (1 + TRAIL_GAIN)) {
      const level = close * (1 - TRAIL_BACK);
      st.trail = st.trail === null ? level : Math.max(st.trail, level);
    }
    if (st.trail !== null && close < st.trail) leave = true;
    if (leave || guardHit) {
      orders.push({
        side: "sell",
        client_id: nextClientId(),
        symbol,
        qty: p.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      st.lastSellBar = barIdx;
      st.bornBar = null;
      st.isRotation = false;
      st.trail = null;
    }
  }

  if (!ready || barIdx < guardUntilBar) return orders;

  // --- trend entries ---------------------------------------------------------
  const selling = new Set(orders.filter((o) => o.side === "sell").map((o) => o.symbol));
  for (const symbol of [...scales.keys()].sort()) {
    if (held.has(symbol) || selling.has(symbol)) continue;
    const st = coinState(symbol);
    if (st.emaFast === null || st.emaSlow === null) continue;
    if (barIdx - st.lastSellBar < COOLDOWN_BARS) continue;
    const r12 = retOver(st, 12);
    const r6 = retOver(st, 6);
    if (r12 === null || r6 === null) continue;
    if (!(st.emaFast > st.emaSlow && r12 > ENTRY_RETURN_12H && r6 > 0)) continue;
    const target = (equity * BigInt(TREND_SIZE_BPS)) / BPS;
    const priceRaw = closeRawBySymbol.get(symbol);
    if (priceRaw === undefined) continue;
    const heldQty = held.get(symbol)?.qty;
    const heldValue = heldQty ? valueRaw(symbol, BigInt(heldQty), priceRaw) : 0n;
    const room =
      (BigInt(hello.caps.max_weight_bps) * equity) / BPS - heldValue;
    let spend = target < room ? target : room;
    if (spend > cashLeft) spend = cashLeft;
    if (spend < BigInt(hello.fees.min_notional_quote_units)) continue;
    if (spend <= 0n) continue;
    orders.push({
      side: "buy",
      client_id: nextClientId(),
      symbol,
      notional_quote_units: spend.toString(),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    cashLeft -= spend;
    st.bornBar = barIdx;
    st.isRotation = false;
    st.trail = null;
  }

  // --- rotation entry: strongest 24h coin every ROT_EVERY_BARS --------------
  if (barIdx % ROT_EVERY_BARS === 0) {
    let best: string | null = null;
    let bestRet = -Infinity;
    for (const symbol of [...scales.keys()].sort()) {
      if (held.has(symbol) || selling.has(symbol)) continue;
      const st = coinState(symbol);
      if (barIdx - st.lastSellBar < COOLDOWN_BARS) continue;
      // skip coins a trend ride just bought this very batch
      if (orders.some((o) => o.side === "buy" && o.symbol === symbol)) continue;
      const r24 = retOver(st, 24);
      if (r24 === null || r24 <= bestRet) continue;
      bestRet = r24;
      best = symbol;
    }
    // Never rotate into a coin sliding downhill: its fast average must sit
    // above its slow one, or its 6-hour return must already be positive.
    let rotationOk = false;
    if (best !== null) {
      const bst = coinState(best);
      const r6 = retOver(bst, 6);
      rotationOk =
        (bst.emaFast !== null &&
          bst.emaSlow !== null &&
          bst.emaFast > bst.emaSlow) ||
        (r6 !== null && r6 > 0);
    }
    if (best !== null && rotationOk && bestRet > ROT_MIN_RETURN_24H) {
      const target = (equity * BigInt(ROT_SIZE_BPS)) / BPS;
      const priceRaw = closeRawBySymbol.get(best);
      if (priceRaw !== undefined) {
        const heldQty = held.get(best)?.qty;
        const heldValue = heldQty ? valueRaw(best, BigInt(heldQty), priceRaw) : 0n;
        const room =
          (BigInt(hello.caps.max_weight_bps) * equity) / BPS - heldValue;
        let spend = target < room ? target : room;
        if (spend > cashLeft) spend = cashLeft;
        if (spend >= BigInt(hello.fees.min_notional_quote_units) && spend > 0n) {
          orders.push({
            side: "buy",
            client_id: nextClientId(),
            symbol: best,
            notional_quote_units: spend.toString(),
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          cashLeft -= spend;
          const st = coinState(best);
          st.bornBar = barIdx;
          st.isRotation = true;
          st.trail = null;
        }
      }
    }
  }

  return orders;
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("ignoring a line that is not JSON");
      continue;
    }
    if (msg.type === "hello") {
      hello = msg as unknown as Hello;
      peakEquity = BigInt(hello.capital.quote_units);
      for (const s of hello.symbols) {
        scales.set(s.symbol, { price: s.price_scale, qty: s.qty_scale });
        coinState(s.symbol);
      }
    } else if (msg.type === "batch") {
      const batch = msg as unknown as Batch;
      const orders = decide(batch);
      barsSeen += 1;
      process.stdout.write(
        JSON.stringify({ type: "reply", seq: batch.seq, orders }) + "\n",
      );
    } else if (msg.type === "done") {
      break;
    }
  }
}

await main();
