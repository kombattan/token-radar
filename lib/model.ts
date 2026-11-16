// Token Launch Radar — valuation model ("radar-3").
//
// Every figure on the board is derived from the sealed snapshot itself:
// no protocol name is special-cased anywhere in this file, so the same
// program run on a future snapshot finds protocols that do not exist yet.
//
// Model, in one paragraph: the snapshot's own tokenized protocols are
// the only pricing evidence there is, so the model is fitted to them.
// A log-log regression of market cap on TVL over every peer with both
// figures (market cap grows at roughly the square root of TVL — big
// protocols carry compressed multiples) gives the base price for any
// TVL. Each DefiLlama category then earns its own intercept, shrunk
// toward zero by peer count, because a category with two peers has
// barely spoken while a category with fifteen has a voice of its own.
// Three further effects are fitted on the residuals the same way —
// seven-day TVL momentum, chain breadth, and tokenless age — each
// slope shrunk by sample size and each contribution capped, so no
// single effect can run away with a row. A pre-token protocol's
// implied value is the fitted price at its own TVL, category,
// momentum, breadth and age. Radar-2 priced rows off a flat category
// median multiple; radar-3 replaces the flat multiple with the fitted
// curve, which is why the two boards rank the same protocols
// differently wherever scale, category or age pull apart.

export interface Protocol {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number; // percent: 5 means TVL grew 5% over 7 days
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
  board_min_tvl_usd: 10_000_000,
  // Category intercepts shrink toward the global curve with this
  // prior strength, counted in peers.
  category_shrink_k: 8,
  // Residual slopes (momentum, breadth, age) shrink toward zero with
  // this prior strength, counted in peers.
  slope_shrink_k: 40,
  // Per-effect caps on the log contribution any one effect may make.
  momentum_log_cap: 0.2,
  breadth_log_cap: 0.15,
  age_log_cap_down: -0.45,
  age_log_cap_up: 0.1,
  // Winsor bounds for the momentum covariate, as a fraction: a
  // protocol cannot lose more than 90% of TVL in a week for pricing
  // purposes, and gains past +200% are treated as +200%.
  momentum_floor: -0.9,
  momentum_cap: 2.0,
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

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Whole days between the protocol's listing date and the snapshot date. */
export function ageInDays(listedAt: string | null, asOf: string): number | null {
  if (!listedAt) return null;
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

/** The momentum covariate: 7-day TVL change as a winsorized fraction. */
function momentumOf(p: Protocol): number {
  const fraction = (p.change_7d ?? 0) / 100;
  return clamp(fraction, MODEL_PARAMS.momentum_floor, MODEL_PARAMS.momentum_cap);
}

/** The breadth covariate: log2 of the chain count (1 chain = 0). */
function breadthOf(p: Protocol): number {
  return Math.log2(Math.max(1, p.chains.length));
}

/** The age covariate: log10 of tokenless age in days, null if unknown. */
function ageCovariate(p: Protocol, asOf: string): number | null {
  const days = ageInDays(p.listed_at, asOf);
  if (days === null) return null;
  return Math.log10(Math.max(1, days));
}

export interface CategoryOffset {
  category: string;
  peer_count: number;
  raw_offset: number; // mean residual, log points
  offset: number; // shrunk offset actually applied, log points
}

export interface ModelFit {
  peer_count: number;
  alpha: number;
  beta: number;
  residual_sd: number;
  category_offsets: Map<string, CategoryOffset>;
  slopes: { momentum: number; breadth: number; age: number };
}

/** Ordinary least squares slope of y on x, or 0 when x has no spread. */
function olsSlope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    varX += (xs[i] - mx) * (xs[i] - mx);
  }
  return varX > 0 ? cov / varX : 0;
}

/**
 * Fit the pricing model on the snapshot's tokenized peers: the base
 * log-log curve, shrunk category intercepts, then shrunk residual
 * slopes for momentum, breadth and age, fitted in that order so each
 * effect explains only what the previous ones left over.
 */
export function fitModel(snapshot: Snapshot): ModelFit {
  const peers = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const xs = peers.map((p) => Math.log(p.tvl_usd));
  const ys = peers.map((p) => Math.log(p.mcap_usd as number));
  const n = peers.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const beta = olsSlope(xs, ys);
  const alpha = my - beta * mx;

  // Residuals off the global curve.
  const residuals = peers.map((p, i) => ys[i] - (alpha + beta * xs[i]));
  const meanResid = residuals.reduce((a, b) => a + b, 0) / n;
  const residualSd = Math.sqrt(
    residuals.reduce((a, r) => a + (r - meanResid) * (r - meanResid), 0) / n,
  );

  // Category intercepts, shrunk toward zero by peer count.
  const byCategory = new Map<string, number[]>();
  peers.forEach((p, i) => {
    const list = byCategory.get(p.category) ?? [];
    list.push(residuals[i]);
    byCategory.set(p.category, list);
  });
  const categoryOffsets = new Map<string, CategoryOffset>();
  for (const [category, list] of byCategory) {
    const raw = list.reduce((a, b) => a + b, 0) / list.length;
    const offset =
      (list.length * raw) / (list.length + MODEL_PARAMS.category_shrink_k);
    categoryOffsets.set(category, {
      category,
      peer_count: list.length,
      raw_offset: raw,
      offset,
    });
  }

  // Residual slopes on what the curve and the categories left over.
  const adjusted = peers.map(
    (p, i) => residuals[i] - (categoryOffsets.get(p.category)?.offset ?? 0),
  );
  const shrink = n / (n + MODEL_PARAMS.slope_shrink_k);
  const slopeFor = (
    covariate: (p: Protocol) => number | null,
  ): number => {
    const cx: number[] = [];
    const cy: number[] = [];
    peers.forEach((p, i) => {
      const v = covariate(p);
      if (v !== null) {
        cx.push(v);
        cy.push(adjusted[i]);
      }
    });
    return olsSlope(cx, cy) * shrink;
  };
  const slopes = {
    momentum: slopeFor((p) => momentumOf(p)),
    breadth: slopeFor((p) => breadthOf(p)),
    age: slopeFor((p) => ageCovariate(p, snapshot.as_of)),
  };

  return {
    peer_count: n,
    alpha,
    beta,
    residual_sd: residualSd,
    category_offsets: categoryOffsets,
    slopes,
  };
}

export interface RowModel {
  base_value_usd: number; // the global curve's price at this TVL
  category_offset: number; // log points applied for the category
  category_peers: number;
  momentum_factor: number;
  breadth_factor: number;
  age_factor: number;
}

/** Price one pre-token protocol with the fitted model. */
export function priceRow(
  p: Protocol,
  fit: ModelFit,
  asOf: string,
): { implied: number; model: RowModel } {
  const baseLog = fit.alpha + fit.beta * Math.log(p.tvl_usd);
  const cat = fit.category_offsets.get(p.category);
  const offset = cat?.offset ?? 0;
  const momentumLog = clamp(
    fit.slopes.momentum * momentumOf(p),
    -MODEL_PARAMS.momentum_log_cap,
    MODEL_PARAMS.momentum_log_cap,
  );
  const breadthLog = clamp(
    fit.slopes.breadth * breadthOf(p),
    -MODEL_PARAMS.breadth_log_cap,
    MODEL_PARAMS.breadth_log_cap,
  );
  const ageCov = ageCovariate(p, asOf);
  const ageLog =
    ageCov === null
      ? 0
      : clamp(
          fit.slopes.age * ageCov,
          MODEL_PARAMS.age_log_cap_down,
          MODEL_PARAMS.age_log_cap_up,
        );
  const implied = Math.max(
    1,
    Math.round(Math.exp(baseLog + offset + momentumLog + breadthLog + ageLog)),
  );
  return {
    implied,
    model: {
      base_value_usd: Math.round(Math.exp(baseLog)),
      category_offset: round4(offset),
      category_peers: cat?.peer_count ?? 0,
      momentum_factor: round4(Math.exp(momentumLog)),
      breadth_factor: round4(Math.exp(breadthLog)),
      age_factor: round4(Math.exp(ageLog)),
    },
  };
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
  age_days: number | null;
  implied_value_usd: number;
  model: RowModel;
  farm_steps: string[];
}

function money(usd: number): string {
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(2)}B`;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

/** A farming position sized to the protocol: roughly one basis point
 *  of its TVL, clamped to a band a single wallet can actually run. */
function sizeBand(p: Protocol): { low: number; high: number } {
  const target = clamp(p.tvl_usd * 0.0001, 250, 10_000);
  return {
    low: Math.round(target / 2 / 10) * 10,
    high: Math.round(target / 10) * 10,
  };
}

/** Monthly gas reality by the chain the farm runs on. General chain
 *  knowledge, stated per chain name — never per protocol. */
function gasBand(chain: string): string {
  const c = chain.toLowerCase();
  if (c.includes("ethereum")) return "$20-80 of ETH gas a month on Ethereum mainnet";
  if (c.includes("solana")) return "well under $1 of SOL fees a month on Solana";
  if (c.includes("bnb") || c.includes("bsc")) return "$1-5 of BNB gas a month on BNB Chain";
  if (c.includes("polygon") || c.includes("pos")) return "under $3 of gas a month on Polygon";
  if (c.includes("arbitrum") || c.includes("base") || c.includes("optimism") || c.includes("scroll") || c.includes("linea") || c.includes("zksync") || c.includes("blast") || c.includes("mantle") || c.includes("mode")) return "$2-10 of ETH gas a month on its L2 gas prices";
  if (c.includes("avax") || c.includes("avalanche")) return "$1-6 of AVAX gas a month";
  return `$2-15 of gas a month on ${chain}`;
}

// Category playbooks: the core farming action differs by what the
// protocol actually does, so the middle steps are written per category
// family and then filled with this protocol's own name, chains and TVL.
// Anything unlisted falls through to the generic DeFi playbook.
const PLAYBOOKS: { match: RegExp; core: (p: Protocol) => string[] }[] = [
  {
    match: /lend|borrow|credit|collateral/i,
    core: (p) => [
      `Supply a blue-chip asset (ETH or a major stablecoin) as collateral on ${p.name} on ${p.chains[0]} and keep utilisation under 60% so a volatile week cannot liquidate you; supplied balances are what lending snapshots almost always measure.`,
      `Open one small borrow against the collateral and repay it within the same week: a completed borrow-repay cycle marks the wallet as a real borrower, not a passive depositor, at a cost of a few dollars of interest.`,
      `Repeat the supply position in two or three tranches over 4-6 weeks instead of one lump sum; staggered deposits read as organic usage and survive anti-sybil filters that flag single-day spikes.`,
    ],
  },
  {
    match: /cdp|stablecoin/i,
    core: (p) => [
      `Open a small collateralised position on ${p.name} on ${p.chains[0]}: deposit a blue-chip collateral asset and mint a modest amount of its stablecoin, keeping the collateral ratio at least 50 points above the liquidation line.`,
      `Use the minted stablecoin inside the ecosystem for a week (hold it, or park it in the protocol's own stability pool) instead of selling it instantly; issuers snapshot stablecoin holders as well as minters.`,
      `Repay and re-mint once a month in varying amounts so the vault shows a living history across several snapshot windows, not a single-day position.`,
    ],
  },
  {
    match: /dex|swap|aggregator|perpetual|deriv|options|prediction/i,
    core: (p) => [
      `Route your ordinary swaps through ${p.name} on ${p.chains[0]} two or three times a week; consistent weekly volume across many weeks is the metric exchange snapshots reward, not one large trade.`,
      `Provide a small, tight liquidity position in the busiest pair on ${p.name} and leave it untouched for at least a month; LP age and fee earnings are cheap to verify on-chain and hard to fake.`,
      `Use one advanced feature most farmers skip (a limit order, a cross-margin position, or the API) so the wallet shows product depth, which several past exchange airdrops weighted explicitly.`,
    ],
  },
  {
    match: /curator|vault|yield|allocator/i,
    core: (p) => [
      `Deposit into the flagship ${p.name} vault on ${p.chains[0]} and hold the receipt token in the same wallet; curator and vault snapshots measure deposit age as much as size.`,
      `Split the deposit across two of ${p.name}'s vaults or strategies if it runs more than one, so the wallet appears in several strategy snapshots rather than a single one.`,
      `Claim and re-deposit rewards monthly instead of selling them: compounding wallets are the cohort every vault protocol wants to keep after launch.`,
    ],
  },
  {
    match: /restak|liquid staking|staking/i,
    core: (p) => [
      `Stake a modest amount through ${p.name} on ${p.chains[0]} and hold the liquid receipt token in the farming wallet; staking snapshots are usually taken on receipt-token balances and their age.`,
      `Use the receipt token once in a second venue (a lending market or LP that accepts it) so the wallet shows the full restaking loop, then return it before month end.`,
      `Keep the position through at least one full rewards epoch; positions that survive an epoch boundary are the ones epoch-based points systems credit.`,
    ],
  },
  {
    match: /rwa|real world|treasur/i,
    core: (p) => [
      `Complete ${p.name}'s onboarding or whitelist on ${p.chains[0]} early, even before depositing: for real-world-asset protocols the verified-user list is often drawn before the capital snapshot.`,
      `Deposit into the flagship ${p.name} product and hold through one full yield distribution; RWA snapshots favour wallets that received distributions over wallets that merely deposited.`,
      `Keep the position documentation (deposit confirmations, distribution records) with the wallet's records; RWA launches skew toward compliance-ready users.`,
    ],
  },
  {
    match: /basis|funding/i,
    core: (p) => [
      `Deposit stablecoins into ${p.name}'s basis strategy on ${p.chains[0]} and hold the position token; basis protocols snapshot position-token balances and holding duration.`,
      `Add to the position in a second, smaller tranche a few weeks later so the wallet appears in more than one snapshot window with a growing balance.`,
      `Track the strategy's funding-rate exposure monthly and be ready to exit if funding flips negative for a sustained period; the farm is only worth its yield plus the token option.`,
    ],
  },
  {
    match: /^chain$|layer|network/i,
    core: (p) => [
      `Bridge a working balance onto ${p.name} and keep it there: hold the gas token, make weekly transactions, and use two or three native dapps so the wallet reads as a resident, not a passer-by.`,
      `Interact with the chain's flagship native protocols (its main DEX and lending market) at least twice a month; ecosystem snapshots for chain tokens weight native activity heavily.`,
      `Avoid bridging everything back out after each use; chains measure retained balances at snapshot time, and wallets that round-trip in a day are the first filtered.`,
    ],
  },
  {
    match: /payment|insurance|index|launchpad|nft|privacy|locker|governance/i,
    core: (p) => [
      `Use ${p.name}'s headline product on ${p.chains[0]} with real funds at least twice a month — a payment sent, a policy held, an index bought; for utility protocols the user list, not the depositor list, is what a launch rewards.`,
      `Hold whatever the product issues (cover note, index token, receipt) in the farming wallet without moving it between wallets, which breaks most tracking.`,
      `Complete the profile or verification steps most users skip inside ${p.name}; completed profiles are a cheap sybil filter and are weighted accordingly.`,
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

/** The exit step, matched to how the category family locks capital. */
function exitStep(p: Protocol): string {
  const c = p.category;
  if (/lend|borrow|cdp|collateral/i.test(c)) {
    return `Pre-plan the exit before you need it: on ${p.name} that means repaying any open borrow before withdrawing collateral, and keeping the health factor above 1.6 while you farm so a bad week cannot liquidate the position you built.`;
  }
  if (/restak|liquid staking|staking/i.test(c)) {
    return `Pre-plan the exit before you need it: staking positions on ${p.name} unwind through an unstaking queue that can take days, so start any exit well before a rumoured snapshot rather than after an announcement.`;
  }
  if (/rwa|real world|treasur/i.test(c)) {
    return `Pre-plan the exit before you need it: RWA products on ${p.name} redeem on set windows and sometimes only to whitelisted wallets, so read the redemption terms before depositing, not after.`;
  }
  if (/vault|curator|yield|basis|allocator/i.test(c)) {
    return `Pre-plan the exit before you need it: check ${p.name}'s withdrawal queue and any lock on the flagship strategy now, and keep the farm under 5% of your stack so a slow exit is an inconvenience, not a problem.`;
  }
  return `Pre-plan the exit before you need it: read ${p.name}'s withdrawal and unlock terms now, keep the position under 5% of your stack, and never let a rumoured snapshot date talk you into size you cannot hold through a delay.`;
}

/**
 * Eight concrete steps per protocol: wallet setup, the category core,
 * position sizing against its own TVL, cadence and snapshot hygiene,
 * honest costs on its own chain, and the exit. Every step names this
 * protocol's own chains, size or mechanics — no step is a slogan.
 */
export function farmStepsFor(p: Protocol): string[] {
  const playbook = PLAYBOOKS.find((b) => b.match.test(p.category)) ?? null;
  const core = playbook ? playbook.core(p) : genericCore(p);
  const chainList = p.chains.slice(0, 3).join(", ");
  const band = sizeBand(p);
  return [
    `Use one dedicated wallet for ${p.name} that also holds your other DeFi positions; fresh empty wallets are discounted by sybil filters, while a wallet with a season of history on ${chainList} is not.`,
    ...core,
    `Size the position at roughly ${money(band.low)}-${money(band.high)} — about one basis point of ${p.name}'s ${money(p.tvl_usd)} TVL: large enough to register in any balance-weighted snapshot, small enough that the capital is never missed elsewhere.`,
    `Check ${p.name}'s official site and X account every week for a points program or season announcement, and screenshot your position monthly; with ${money(p.tvl_usd)} of TVL already inside, a token and a retroactive snapshot are a matter of timing, not possibility.`,
    `Budget the farm honestly: expect roughly ${gasBand(p.chains[0])} plus the opportunity cost of the locked capital, and judge the farm on that all-in cost against a token that does not exist yet.`,
    exitStep(p),
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
  const fit = fitModel(snapshot);
  const watch = new Set(snapshot.watchlist);
  const rows: BoardRow[] = selectBoardProtocols(snapshot).map((p) => {
    const { implied, model } = priceRow(p, fit, snapshot.as_of);
    return {
      rank: 0, // assigned after sorting
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: round2(p.change_7d),
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: "pre-token",
      watchlist: watch.has(p.slug),
      age_days: ageInDays(p.listed_at, snapshot.as_of),
      implied_value_usd: implied,
      model,
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

/** The dashboard's data payload: the board, the fitted model with its
 *  parameters, and the tokenized peer set, so the page can recompute
 *  every row's price in front of the reader from the same figures. */
export function dashboardData(snapshot: Snapshot, rows: BoardRow[]) {
  const fit = fitModel(snapshot);
  const peers = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: round2(p.change_7d),
    }));
  const categories = [...fit.category_offsets.values()]
    .map((c) => ({
      category: c.category,
      peer_count: c.peer_count,
      raw_offset: round4(c.raw_offset),
      offset: round4(c.offset),
      multiple: round4(Math.exp(c.offset)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: {
      name: "radar-3",
      ...MODEL_PARAMS,
      alpha: round4(fit.alpha),
      beta: round4(fit.beta),
      residual_sd: round4(fit.residual_sd),
      peer_count: fit.peer_count,
      slopes: {
        momentum: round4(fit.slopes.momentum),
        breadth: round4(fit.slopes.breadth),
        age: round4(fit.slopes.age),
      },
    },
    rows,
    peers,
    categories,
  };
}
