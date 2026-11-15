// Token Launch Radar — valuation model ("radar-2").
//
// Every figure on the board is derived from the sealed snapshot itself:
// no protocol name is special-cased anywhere in this file, so the same
// program run on a future snapshot finds protocols that do not exist yet.
//
// Model, in one paragraph: a pre-token protocol is priced off the
// tokenized peers in its own DefiLlama category. Each peer contributes a
// market-cap / TVL ratio; the category median of those ratios is shrunk
// toward the market-wide median by peer count (a category with one peer
// is mostly the market, a category with thirty peers is mostly itself),
// then winsorized into [0.02, 2.00] so a single mania or a dead category
// cannot dominate. The shrunk ratio is adjusted by the protocol's own
// clamped 7-day TVL growth and by a slow log maturity factor on its
// tokenless age, and implied value = TVL x ratio x growth x maturity.

export interface Protocol {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number; // fraction: 0.05 means +5% over 7 days
  mcap_usd: number | null; // null while the protocol has no token
  listed_at: string | null; // DefiLlama listing date, YYYY-MM-DD
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export const MODEL_PARAMS = {
  shrink_k: 6,
  ratio_floor: 0.02,
  ratio_cap: 2.0,
  growth_weight: 0.35,
  growth_clamp: 0.3,
  maturity_weight: 0.034,
  board_min_tvl_usd: 25_000_000,
} as const;

// Categories whose TVL is custodial float rather than farmable protocol
// usage: exchange balances (CEX) and the collateral locked behind
// wrapped assets (the bridge categories). Pricing an exchange's balance
// sheet as an airdrop opportunity would swamp the board, and no farming
// action exists for either, so the board leaves them out by category —
// never by protocol name.
export const NON_FARMABLE_CATEGORIES = new Set([
  "CEX",
  "Bridge",
  "Canonical Bridge",
  "Cross Chain Bridge",
]);

export interface CategoryStat {
  category: string;
  peer_count: number;
  median_ratio: number;
  shrunk_ratio: number;
}

export interface PeerStats {
  market_median_ratio: number;
  peer_count: number;
  by_category: Map<string, CategoryStat>;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Ratios of the tokenized peers, per category and for the whole market. */
export function computePeerStats(protocols: Protocol[]): PeerStats {
  const ratiosByCategory = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const p of protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    allRatios.push(ratio);
    const list = ratiosByCategory.get(p.category) ?? [];
    list.push(ratio);
    ratiosByCategory.set(p.category, list);
  }
  const marketMedian = allRatios.length > 0 ? median(allRatios) : 0;
  const byCategory = new Map<string, CategoryStat>();
  for (const [category, ratios] of ratiosByCategory) {
    const med = median(ratios);
    const n = ratios.length;
    const shrunk =
      (n * med + MODEL_PARAMS.shrink_k * marketMedian) /
      (n + MODEL_PARAMS.shrink_k);
    byCategory.set(category, {
      category,
      peer_count: n,
      median_ratio: med,
      shrunk_ratio: clamp(shrunk, MODEL_PARAMS.ratio_floor, MODEL_PARAMS.ratio_cap),
    });
  }
  return {
    market_median_ratio: marketMedian,
    peer_count: allRatios.length,
    by_category: byCategory,
  };
}

/** The comparison ratio applied to one protocol, with its peer evidence. */
export function ratioFor(
  category: string,
  stats: PeerStats,
): { ratio: number; peer_count: number } {
  const stat = stats.by_category.get(category);
  if (stat) return { ratio: stat.shrunk_ratio, peer_count: stat.peer_count };
  // A category with no tokenized peer at all falls back to the market
  // median itself, winsorized the same way as every other ratio.
  return {
    ratio: clamp(
      stats.market_median_ratio,
      MODEL_PARAMS.ratio_floor,
      MODEL_PARAMS.ratio_cap,
    ),
    peer_count: 0,
  };
}

/** Whole days between the protocol's listing date and the snapshot date. */
export function ageInDays(listedAt: string | null, asOf: string): number {
  if (!listedAt) return 0;
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number; // percent, for display: 2.37 means +2.37%
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: string;
  watchlist: boolean;
  age_days: number;
  implied_value_usd: number;
  model: {
    comp_ratio: number;
    comp_count: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number;
  };
  farm_steps: string[];
}

function money(usd: number): string {
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(2)}B`;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

// Category playbooks: the core farming action differs by what the
// protocol actually does, so the middle steps are written per category
// family and then filled with this protocol's own name, chains and TVL.
// Anything unlisted falls through to the generic DeFi playbook.
const PLAYBOOKS: { match: RegExp; core: (p: Protocol) => string[] }[] = [
  {
    match: /lend|borrow|cdp|credit/i,
    core: (p) => [
      `Supply a blue-chip asset (ETH or a major stablecoin) as collateral on ${p.name} on ${p.chains[0]} and keep utilisation under 60% so a volatile week cannot liquidate you; supplied balances are what lending snapshots almost always measure.`,
      `Open one small borrow against the collateral and repay it within the same week: a completed borrow-repay cycle marks the wallet as a real borrower, not a passive depositor, at a cost of a few dollars of interest.`,
      `Repeat the supply position in two or three tranches over 4-6 weeks instead of one lump sum; staggered deposits read as organic usage and survive anti-sybil filters that flag single-day spikes.`,
    ],
  },
  {
    match: /dex|swap|aggregator|perpetual|deriv|options/i,
    core: (p) => [
      `Route your ordinary swaps through ${p.name} on ${p.chains[0]} two or three times a week; consistent weekly volume across many weeks is the metric exchange snapshots reward, not one large trade.`,
      `Provide a small, tight liquidity position in the busiest pair on ${p.name} and leave it untouched for at least a month; LP age and fee earnings are cheap to verify on-chain and hard to fake.`,
      `Use one advanced feature most farmers skip (a limit order, a cross-margin position, or the API) so the wallet shows product depth, which several past exchange airdrops weighted explicitly.`,
    ],
  },
  {
    match: /curator|vault|yield|restak|liquid staking|staking/i,
    core: (p) => [
      `Deposit into the flagship ${p.name} vault on ${p.chains[0]} and hold the receipt token in the same wallet; curator and vault snapshots measure deposit age as much as size.`,
      `Split the deposit across two of ${p.name}'s vaults or strategies if it runs more than one, so the wallet appears in several strategy snapshots rather than a single one.`,
      `Claim and re-deposit rewards monthly instead of selling them: compounding wallets are the cohort every vault protocol wants to keep after launch.`,
    ],
  },
  {
    match: /bridge|interoperab|messaging|cross/i,
    core: (p) => [
      `Bridge a modest amount through ${p.name} to ${p.chains[1] ?? p.chains[0]} and actually use the funds on the far side for a week; round-trip bridges in one block are the first pattern filtered out.`,
      `Repeat the bridge monthly in varying amounts and routes so the wallet builds a history across corridors, which is how interoperability protocols rank their real users.`,
      `Hold a small balance on each chain ${p.name} serves at the end of each month; stranded dust on destination chains is a surprisingly common snapshot criterion.`,
    ],
  },
];

function genericCore(p: Protocol): string[] {
  return [
    `Make ${p.name}'s core product action on ${p.chains[0]} with real funds at least twice a month; whatever the protocol sells, its first snapshot will count wallets that used it repeatedly.`,
    `Hold the position the protocol issues you (deposit receipt, LP token or account balance) in the farming wallet without moving it between wallets, which breaks most tracking.`,
    `Add a second, smaller action most users skip (a governance vote, a referral-free second product, or a testnet-to-mainnet trail) so the wallet shows depth beyond the headline feature.`,
  ];
}

/**
 * Six concrete steps per protocol: wallet setup, the category core,
 * cadence and snapshot hygiene, then costs and exit. Every step names
 * this protocol's own chains, size or mechanics — no step is a slogan.
 */
export function farmStepsFor(p: Protocol): string[] {
  const playbook = PLAYBOOKS.find((b) => b.match.test(p.category)) ?? null;
  const core = playbook ? playbook.core(p) : genericCore(p);
  const chainList = p.chains.slice(0, 3).join(", ");
  return [
    `Use one dedicated wallet for ${p.name} that also holds your other DeFi positions; fresh empty wallets are discounted by sybil filters, while a wallet with a season of history on ${chainList} is not.`,
    ...core,
    `Check ${p.name}'s official site and X account every week for a points program or season announcement, and screenshot your position monthly; with ${money(p.tvl_usd)} of TVL already inside, a token and a retroactive snapshot are a matter of timing, not possibility.`,
    `Budget the farm honestly: expect roughly $5-40 of gas per month on ${p.chains[0]} plus the opportunity cost of the locked capital, keep the position under 5% of your stack, and pre-plan the exit (unstake windows, unlock queues) before any snapshot date is announced.`,
  ];
}

/** Select the board. A protocol qualifies as pre-token when the snapshot
 *  records no token for it at all: no market cap and no symbol. On top of
 *  that the board takes every watchlist protocol (the competition's own
 *  list, whatever its size), plus any other pre-token protocol at or
 *  above the board's TVL line whose category is farmable. */
export function selectBoardProtocols(snapshot: Snapshot): Protocol[] {
  const watch = new Set(snapshot.watchlist);
  return snapshot.protocols.filter((p) => {
    if (p.mcap_usd !== null || p.symbol !== null) return false;
    if (watch.has(p.slug)) return true;
    if (NON_FARMABLE_CATEGORIES.has(p.category)) return false;
    return p.tvl_usd >= MODEL_PARAMS.board_min_tvl_usd;
  });
}

/** Build the ranked board: implied value descending, TVL then slug as
 *  deterministic tie-breaks, ranks exactly 1..N. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const stats = computePeerStats(snapshot.protocols);
  const watch = new Set(snapshot.watchlist);
  const rows: BoardRow[] = selectBoardProtocols(snapshot).map((p) => {
    const { ratio, peer_count } = ratioFor(p.category, stats);
    const age = ageInDays(p.listed_at, snapshot.as_of);
    const growth = clamp(
      p.change_7d,
      -MODEL_PARAMS.growth_clamp,
      MODEL_PARAMS.growth_clamp,
    );
    const growthMultiplier = 1 + MODEL_PARAMS.growth_weight * growth;
    const maturityMultiplier =
      1 + MODEL_PARAMS.maturity_weight * Math.log10(Math.max(age, 1));
    const implied = Math.round(
      p.tvl_usd * ratio * growthMultiplier * maturityMultiplier,
    );
    return {
      rank: 0, // assigned after sorting
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: round4(p.change_7d * 100),
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: "pre-token",
      watchlist: watch.has(p.slug),
      age_days: age,
      implied_value_usd: implied,
      model: {
        comp_ratio: round4(ratio),
        comp_count: peer_count,
        growth_pct: round4(p.change_7d * 100),
        growth_multiplier: round4(growthMultiplier),
        maturity_multiplier: round4(maturityMultiplier),
        age_days: age,
      },
      farm_steps: farmStepsFor(p),
    };
  });
  rows.sort(
    (a, b) =>
      b.implied_value_usd - a.implied_value_usd ||
      b.tvl_usd - a.tvl_usd ||
      a.slug.localeCompare(b.slug),
  );
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });
  return rows;
}

/** The dashboard's data payload: the board plus the tokenized peer set,
 *  so the page can recompute every ratio in front of the reader and
 *  show exactly which peers priced each row. */
export function dashboardData(snapshot: Snapshot, rows: BoardRow[]) {
  const stats = computePeerStats(snapshot.protocols);
  const peers = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: round4(p.change_7d * 100),
    }));
  const categories = [...stats.by_category.values()]
    .map((s) => ({
      category: s.category,
      peer_count: s.peer_count,
      median_ratio: round4(s.median_ratio),
      shrunk_ratio: round4(s.shrunk_ratio),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: {
      ...MODEL_PARAMS,
      market_median_ratio: round4(stats.market_median_ratio),
      peer_count: stats.peer_count,
    },
    rows,
    peers,
    categories,
  };
}
