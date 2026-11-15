// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds the
// pre-token protocols the watchlist's own exclusions kept out or that sit below its $50M floor: the
// early rows a radar exists to find. A protocol is pre-token when its record carries no token (no
// market cap, no CoinGecko id, no symbol). Live-token protocols are kept apart and shown at the
// market's own values, never mixed into the ranked board.
//
// Implied value is priced off the snapshot's own comparables, never off a list of names:
//
//   comps       = the tokenized protocols in the same category, each with ratio mcap_usd / tvl_usd
//   ratio_c     = the category's median ratio, shrunk toward the global median G by its sample size:
//                 (n x median_c + K x G) / (n + K), K = 6, then winsorized to [0.02, 2.00]
//   growthMult  = 1 + clamp(change_7d, -50, 100) / 100 x 0.35     (a missing change counts as 0)
//   maturity    = 0.80 + 0.35 x ln(1 + age_days) / ln(1 + 1460)   (an unknown age counts as 365)
//   implied     = max(1, round(tvl_usd x ratio_c x growthMult x maturity))
//
// A young category with two wild comparables cannot drag its protocols to a wild price: the median
// resists outliers, the shrinkage pulls small samples toward the whole market's median, and the
// winsor band keeps any single category inside the range the snapshot's own ratios actually span.
// The same function scores every row; the dashboard restates it and recomputes each row from the
// figures data.js carries, so the page and board.json cannot drift apart.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  shrink_k: number;
  ratio_floor: number;
  ratio_cap: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_base: number;
  maturity_span: number;
  maturity_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  shrink_k: 6,
  ratio_floor: 0.02,
  ratio_cap: 2,
  growth_weight: 0.35,
  growth_floor: -50,
  growth_cap: 100,
  maturity_base: 0.8,
  maturity_span: 0.35,
  maturity_days: 1460,
  unknown_age_days: 365,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** The board never holds more rows than this; additions fill it by TVL after the watchlist. */
export const MAX_BOARD_ROWS = 260;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 30;

/** One category's comparables: how many tokenized protocols priced it, and the ratio they imply. */
export interface CategoryRatio {
  category: string | null;
  comps: number;
  median: number | null;
  ratio: number;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    comp_ratio: number;
    comp_count: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's view of one row: the board row's figures plus its farm plan, verbatim. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  comp_ratio: number;
  comp_count: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  global_ratio: number;
  tokenized_comps: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a list, or null when it is empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The comparables table: one ratio per category, from the snapshot's tokenized protocols alone.
 * The global median prices a category with no tokenized comparable at all.
 */
export function categoryRatios(snapshot: Snapshot, model: ModelConstants = MODEL): { global: number; comps: number; byCategory: Map<string | null, CategoryRatio> } {
  const ratios: number[] = [];
  const grouped = new Map<string | null, number[]>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const r = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(r) || r <= 0) continue;
    ratios.push(r);
    const list = grouped.get(p.category) ?? [];
    list.push(r);
    grouped.set(p.category, list);
  }
  const global = round4(median(ratios) ?? 0.17);
  const byCategory = new Map<string | null, CategoryRatio>();
  const categories = new Set<string | null>([...grouped.keys(), ...snapshot.protocols.map((p) => p.category)]);
  for (const category of categories) {
    const list = grouped.get(category) ?? [];
    const med = median(list);
    const shrunk = med === null ? global : (list.length * med + model.shrink_k * global) / (list.length + model.shrink_k);
    const ratio = round4(Math.min(model.ratio_cap, Math.max(model.ratio_floor, shrunk)));
    byCategory.set(category, { category, comps: list.length, median: med === null ? null : round4(med), ratio });
  }
  return { global, comps: ratios.length, byCategory };
}

/** The growth and maturity multipliers one protocol gets, each rounded as the dashboard states them. */
export function multipliers(protocol: SnapshotProtocol, asOf: string, model: ModelConstants): { growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, finite(protocol.change_7d, 0)));
  const growthMult = round4(1 + (growthPct / 100) * model.growth_weight);
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = round4(model.maturity_base + model.maturity_span * (Math.log(1 + Math.max(ageForModel, 0)) / Math.log(1 + model.maturity_days)));
  return { growthPct, growthMult, maturityMult, age };
}

/** The implied value of one protocol under the comparables table. */
export function impliedValue(protocol: SnapshotProtocol, asOf: string, ratios: Map<string | null, CategoryRatio>, model: ModelConstants = MODEL): { implied: number; ratio: number; comps: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const entry = ratios.get(protocol.category);
  const ratio = entry?.ratio ?? 0.17;
  const comps = entry?.comps ?? 0;
  const { growthPct, growthMult, maturityMult, age } = multipliers(protocol, asOf, model);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * ratio * growthMult * maturityMult));
  return { implied, ratio, comps, growthPct, growthMult, maturityMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A name carrying a whole word that marks a wrapped or staked product of another asset. */
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;

/** Names that begin with an exchange's name: the house's own watchlist exclusion, kept for additions. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/** Categories the watchlist itself sets aside as products or venues, kept aside for additions too. */
const PRODUCT_CATEGORIES = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a pre-token protocol may join the board beyond the watchlist: not a venue, not a product
 * of a token that already trades, and not a versioned pool of another protocol.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    !(p.category !== null && PRODUCT_CATEGORIES.has(p.category)) &&
    !VERSIONED.test(p.name) &&
    !PRODUCT_WORD.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name)
  );
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const watchlist = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but
  // the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // Beyond the floor: every other rankable pre-token protocol, largest TVL first, up to the cap.
  // This reaches the big names the watchlist's exclusions kept out and the early protocols below
  // the $50M floor alike; a chosen protocol stays chosen.
  const additions = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of additions) {
    if (chosen.size >= MAX_BOARD_ROWS) break;
    chosen.set(p.slug, p);
  }

  const { byCategory } = categoryRatios(snapshot, model);
  const scored = [...chosen.values()].map((p) => ({ p, ...impliedValue(p, snapshot.as_of, byCategory, model) }));
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    watchlist: watchlist.has(s.p.slug),
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      comp_ratio: s.ratio,
      comp_count: s.comps,
      growth_pct: s.growthPct,
      growth_multiplier: s.growthMult,
      maturity_multiplier: s.maturityMult,
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** What one transaction costs on a chain, as the farm plans state it. */
function gasFor(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 'about $12 of ETH in gas at a normal fee window';
  if (c === 'solana') return 'about $0.05 of SOL in fees';
  if (c === 'base' || c === 'arbitrum' || c === 'optimism' || c === 'zksync era' || c === 'linea') return 'about $0.25 of ETH in gas';
  if (c === 'bsc' || c === 'bnb chain') return 'about $0.30 of BNB in gas';
  if (c === 'polygon') return 'about $0.02 of POL in gas';
  if (c === 'avalanche') return 'about $0.40 of AVAX in gas';
  if (c === 'sui' || c === 'aptos') return 'about $0.05 of gas';
  if (c === 'bitcoin') return 'about $2 of BTC in miner fees';
  return 'about $1 of gas';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  if (p.tvl_usd >= 10_000_000) return 75;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** A small deterministic pick from a slug, so twin protocols do not read word for word alike. */
function variant(slug: string, count: number): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h % count;
}

/** The category's core action and its follow-up, in words a farmer can follow. */
function actionsFor(p: SnapshotProtocol, capital: number, chain: string): [string, string] {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  const v = variant(p.slug, 2);
  if (c.includes('lend') || c.includes('collateral'))
    return [
      `Supply $${capital} of USDC to ${n} on ${chain}, then borrow about 40% of it back in the same market.`,
      `Repay and re-borrow once a week so the borrow balance never sits idle, and keep the health factor above 2.`,
    ];
  if (c.includes('cdp'))
    return [
      `Deposit $${capital} of collateral into a ${n} vault on ${chain} and mint its stablecoin at under 50% of the vault's limit.`,
      `Hold or spend the minted stablecoin inside ${n}'s own app, and top the vault up whenever collateral prices fall 10%.`,
    ];
  if (c.includes('dex'))
    return [
      `Provide $${capital} split evenly across ${n}'s busiest stablecoin pool on ${chain} and keep the LP position open.`,
      v === 0
        ? `Route one swap of about $25 through ${n} every week, alternating direction, so the wallet shows real trading volume.`
        : `Rebalance the LP position back to even whenever one side drifts past 60%, and compound the fees monthly.`,
    ];
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options'))
    return [
      `Deposit $${capital} of USDC as margin on ${n} and open a small hedged pair: long one market, short the same size on a correlated one.`,
      `Trade about $100 of volume a week in small clips and keep the hedge on, so the account reads as a hedger, not a gambler.`,
    ];
  if (c.includes('bridge'))
    return [
      `Bridge $${capital} of USDC from Ethereum to ${chain} through ${n}, then use the bridged funds in one app on the far side.`,
      `Bridge a smaller amount back the other way once a month, so the wallet has crossings in both directions.`,
    ];
  if (c.includes('restak'))
    return [
      `Restake $${capital} of liquid staking tokens through ${n} on ${chain} and keep the receipt token in the same wallet.`,
      `Pick one actively validated service inside ${n} and leave the delegation untouched for the whole hold.`,
    ];
  if (c.includes('staking') || c === 'chain')
    return [
      `Stake $${capital} of the chain's native asset through ${n} and keep the staking receipt in the farming wallet.`,
      `Use the receipt token once in a lending market or pool that ${n} itself links to, so the wallet shows staking and DeFi activity.`,
    ];
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk'))
    return [
      `Deposit $${capital} into one established ${n} vault on ${chain}, choosing the vault with the longest track record, not the highest rate.`,
      `Split a second $${Math.round(capital / 2)} into a different ${n} vault after two weeks, so the wallet holds more than one curator's risk.`,
    ];
  if (c.includes('prediction'))
    return [
      `Fund the account with $${capital} and take one position in ${n}'s most liquid market, sized under 5% of its book.`,
      `Trade in and out of two more markets over the month, settling at least one position in full.`,
    ];
  if (c.includes('stable') || c.includes('basis'))
    return [
      `Mint or deposit $${capital} of the yield-bearing stable asset through ${n} on ${chain} and hold it unstaked.`,
      `Stake half of it in ${n}'s own staking contract if one is offered, keeping the rest liquid for a quick exit.`,
    ];
  if (c.includes('rwa'))
    return [
      `Complete ${n}'s onboarding or KYC if it asks, then mint $${capital} of its yield asset on ${chain}.`,
      `Hold the asset through one full distribution cycle and claim the payout from ${n}'s own page when it lands.`,
    ];
  if (c.includes('insurance'))
    return [
      `Buy $${capital} of cover from ${n} on ${chain} against a position you actually hold, and keep the policy to expiry.`,
      `Renew the cover once when it lapses, so the wallet shows two separate policy periods.`,
    ];
  if (c.includes('privacy'))
    return [
      `Deposit $${capital} through ${n}'s own interface on ${chain} in one transaction, and keep the note or commitment it returns.`,
      `Make one withdrawal to a fresh address after the hold, following ${n}'s own waiting guidance.`,
    ];
  if (c.includes('payment') || c.includes('card'))
    return [
      `Open a ${n} account, fund it with $${capital}, and route one real payment or card spend through it.`,
      `Keep a balance above $25 in the account and make one transaction a week.`,
    ];
  if (c.includes('yield') || c.includes('farm') || c.includes('liquidity'))
    return [
      `Deposit $${capital} into ${n}'s main vault on ${chain} and keep the vault shares in the farming wallet.`,
      v === 0
        ? `Compound the yield back into the vault once a month instead of withdrawing it.`
        : `Move a quarter of the position into a second ${n} vault after the first month, so the wallet is not in a single strategy.`,
    ];
  if (c.includes('index'))
    return [
      `Buy $${capital} of ${n}'s headline index token on ${chain} and hold it in the farming wallet.`,
      `Add about $10 a week to the same index, so the wallet shows a steady accumulation pattern.`,
    ];
  return [
    `Deposit $${capital} of USDC into ${n} on ${chain} through its own app and keep the position open.`,
    `Repeat the deposit with about $25 once a month, so the wallet's history spans several snapshots.`,
  ];
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const gas = gasFor(chain);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const [core, follow] = actionsFor(p, capital, chain);
  return [
    {
      text: `Use a fresh wallet for ${p.name} that holds only the funds you plan to farm, keep its seed phrase offline, and fund it on ${chain}.`,
      cost: gas,
      time: '10 minutes',
    },
    { text: core, cost: `$${capital} of capital and ${gas}`, time: '15 minutes to set up' },
    { text: follow, cost: 'about $2 of gas a week', time: '10 minutes a week' },
    {
      text:
        age !== null && age >= 540
          ? `Vote in ${p.name}'s governance or community calls whenever one opens during the hold: long-running protocols weight voters when they plan a token.`
          : `Make one qualifying action every week (a deposit, a swap, a vote or a claim check) so no week in the hold is empty.`,
      cost: 'about $1 of gas a vote or action',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot, and check ${p.name}'s own points or rewards page before you withdraw anything.`,
      cost: `the $${capital} stays in the position, and never pay anyone to claim`,
      time: `${hold} days`,
    },
    {
      text: `Write the wallet, the dates and every transaction hash in a farm log, and unwind only through ${p.name}'s own interface when you decide to exit.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's form for data.js: every figure the page shows, and the farm plan verbatim. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    watchlist: row.watchlist,
    implied_value_usd: row.implied_value_usd,
    comp_ratio: row.model.comp_ratio,
    comp_count: row.model.comp_count,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const { global, comps } = categoryRatios(snapshot, model);
  const early = board.filter((r) => !r.watchlist).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    global_ratio: global,
    tokenized_comps: comps,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
