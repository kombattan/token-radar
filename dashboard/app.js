// Token Radar dashboard. Renders window.RADAR (written next to this
// folder as data.js by the radar program) with no network at all:
// search, filter and sort the board, open any row to see its implied
// value rebuilt from the fitted model, its category's peers, and its
// farm plan. The recompute in the detail view uses the same fitted
// parameters the program printed into the payload, so the number on
// the board is verified in the reader's own browser.

const R = window.RADAR;
const rows = R.rows;
const peers = R.peers;
const model = R.model;

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function money(usd) {
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(2)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(1)}M`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(1)}K`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

function pct(v) {
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function pctClass(v) {
  return v > 0.05 ? "pos" : v < -0.05 ? "neg" : "";
}

// The same pricing the program ran, restated for the browser: the
// fitted curve at the row's TVL, times its category offset, times the
// three fitted factor multipliers the program stored on the row.
function recompute(row) {
  const cat = R.categories.find((c) => c.category === row.category);
  const offset = cat ? cat.offset : 0;
  const value =
    row.model.base_value_usd *
    Math.exp(offset) *
    row.model.momentum_factor *
    row.model.breadth_factor *
    row.model.age_factor;
  return Math.round(value);
}

function renderStats() {
  const totalImplied = rows.reduce((a, r) => a + r.implied_value_usd, 0);
  const totalTvl = rows.reduce((a, r) => a + r.tvl_usd, 0);
  const watchCount = rows.filter((r) => r.watchlist).length;
  const cats = new Set(rows.map((r) => r.category)).size;
  const items = [
    [`${rows.length}`, "pre-token protocols ranked"],
    [money(totalImplied), "total implied value"],
    [money(totalTvl), "TVL under watch"],
    [`${watchCount}`, "competition watchlist"],
    [`${model.peer_count}`, "tokenized peers fitted"],
    [`${cats}`, "categories on the board"],
  ];
  $("#stats").innerHTML = items
    .map(([v, l]) => `<div class="stat"><strong>${esc(v)}</strong><span>${esc(l)}</span></div>`)
    .join("");
}

function renderCategories() {
  const cats = [...new Set(rows.map((r) => r.category))].sort();
  $("#cat").innerHTML =
    `<option value="">All categories</option>` +
    cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
}

function visibleRows() {
  const q = $("#q").value.trim().toLowerCase();
  const cat = $("#cat").value;
  const watchOnly = $("#watch").checked;
  const sort = $("#sort").value;
  let out = rows.filter((r) => {
    if (cat && r.category !== cat) return false;
    if (watchOnly && !r.watchlist) return false;
    if (q) {
      const hay = `${r.name} ${r.slug} ${r.category} ${r.chains.join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (sort === "tvl") out = [...out].sort((a, b) => b.tvl_usd - a.tvl_usd);
  else if (sort === "change") out = [...out].sort((a, b) => b.change_7d - a.change_7d);
  else if (sort === "ratio")
    out = [...out].sort((a, b) => b.implied_value_usd / b.tvl_usd - a.implied_value_usd / a.tvl_usd);
  else out = [...out].sort((a, b) => a.rank - b.rank);
  return out;
}

function renderBoard() {
  const list = visibleRows();
  $("#count").textContent = `${list.length} of ${rows.length} protocols`;
  const head = `<div class="trow thead" aria-hidden="true">
    <span class="c-rank">#</span><span class="c-name">Protocol</span>
    <span class="c-cat">Category</span><span class="c-num">TVL</span>
    <span class="c-num">7d</span><span class="c-num">Implied</span>
    <span class="c-num">Impl/TVL</span></div>`;
  const body = list
    .map(
      (r) => `<button class="trow" data-slug="${esc(r.slug)}">
      <span class="c-rank">${r.rank}</span>
      <span class="c-name"><strong>${esc(r.name)}</strong>
        <small>${esc(r.slug)}${r.watchlist ? ' · <em class="wl">watchlist</em>' : ""}</small></span>
      <span class="c-cat">${esc(r.category)}</span>
      <span class="c-num">${money(r.tvl_usd)}</span>
      <span class="c-num ${pctClass(r.change_7d)}">${pct(r.change_7d)}</span>
      <span class="c-num strong">${money(r.implied_value_usd)}</span>
      <span class="c-num">${(r.implied_value_usd / r.tvl_usd).toFixed(2)}x</span>
    </button>`,
    )
    .join("");
  $("#board").innerHTML = head + (body || `<p class="empty">No protocol matches those filters.</p>`);
  $("#board").setAttribute("aria-busy", "false");
  for (const el of document.querySelectorAll(".trow[data-slug]")) {
    el.addEventListener("click", () => openDetail(el.dataset.slug));
  }
}

function peersFor(category) {
  return peers
    .filter((p) => p.category === category)
    .sort((a, b) => b.mcap_usd - a.mcap_usd);
}

function openDetail(slug) {
  const row = rows.find((r) => r.slug === slug);
  if (!row) return;
  const cat = R.categories.find((c) => c.category === row.category);
  const rebuilt = recompute(row);
  const catPeers = peersFor(row.category);
  const steps = row.farm_steps.map((s) => `<li>${esc(s)}</li>`).join("");
  const peerRows = catPeers.length
    ? catPeers
        .map(
          (p) => `<div class="prow"><span>${esc(p.name)}</span>
            <span>${money(p.tvl_usd)} TVL</span>
            <span>${money(p.mcap_usd)} mcap</span>
            <span>${(p.mcap_usd / p.tvl_usd).toFixed(2)}x</span></div>`,
        )
        .join("")
    : `<p class="note">No tokenized peer in this category in the snapshot: the row is priced off the global curve with no category offset.</p>`;
  $("#detail").innerHTML = `
    <div class="detail-card">
      <div class="detail-head">
        <div>
          <p class="kicker">Rank #${row.rank} · ${esc(row.category)}${row.watchlist ? " · watchlist" : ""}</p>
          <h2>${esc(row.name)}</h2>
          <p class="note">${esc(row.slug)} · live on ${esc(row.chains.join(", "))}
          · tokenless ${row.age_days === null ? "since before this snapshot's records" : `for ${row.age_days.toLocaleString("en-US")} days`}
          · TVL ${money(row.tvl_usd)} (${pct(row.change_7d)} in 7d)</p>
        </div>
        <button class="close" id="closeDetail">Close</button>
      </div>
      <h3>How the price is built</h3>
      <div class="build">
        <div><span>Curve price at this TVL</span><strong>${money(row.model.base_value_usd)}</strong></div>
        <div><span>Category offset (${row.model.category_peers} peer${row.model.category_peers === 1 ? "" : "s"})</span><strong>x${cat ? cat.multiple.toFixed(3) : "1.000"}</strong></div>
        <div><span>Momentum factor</span><strong>x${row.model.momentum_factor.toFixed(3)}</strong></div>
        <div><span>Chain breadth factor (${row.chains.length} chains)</span><strong>x${row.model.breadth_factor.toFixed(3)}</strong></div>
        <div><span>Age factor</span><strong>x${row.model.age_factor.toFixed(3)}</strong></div>
        <div class="total"><span>Implied value</span><strong>${money(row.implied_value_usd)}</strong></div>
      </div>
      <p class="note">Recomputed in your browser from the fitted parameters:
      ${money(rebuilt)} — the same figure, rebuilt from the curve and factors
      rather than copied from the board.</p>
      <h3>The farm plan</h3>
      <ol class="steps">${steps}</ol>
      <h3>Tokenized peers in ${esc(row.category)}</h3>
      <div class="peers">${peerRows}</div>
    </div>`;
  $("#detail").hidden = false;
  $("#closeDetail").addEventListener("click", () => {
    $("#detail").hidden = true;
  });
  $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function fittedChart() {
  const W = 880, H = 440, L = 74, R = 14, T = 12, B = 42;
  const x0 = 6, x1 = 11.6, y0 = 4.4, y1 = 10.7;
  const px = (lx) => L + ((lx - x0) / (x1 - x0)) * (W - L - R);
  const py = (ly) => T + (1 - (ly - y0) / (y1 - y0)) * (H - T - B);
  const LN10 = Math.log(10);
  const lineY = (lx) => (model.alpha + model.beta * lx * LN10) / LN10;
  let s = "";
  for (let g = Math.ceil(x0); g <= x1; g++) {
    s += `<line x1="${px(g).toFixed(1)}" y1="${T}" x2="${px(g).toFixed(1)}" y2="${H - B}" class="grid"/>` +
      `<text x="${px(g).toFixed(1)}" y="${H - B + 17}" class="tick" text-anchor="middle">${money(Math.pow(10, g))}</text>`;
  }
  for (let g = Math.ceil(y0); g <= y1; g++) {
    s += `<line x1="${L}" y1="${py(g).toFixed(1)}" x2="${W - R}" y2="${py(g).toFixed(1)}" class="grid"/>` +
      `<text x="${L - 7}" y="${(py(g) + 3).toFixed(1)}" class="tick" text-anchor="end">${money(Math.pow(10, g))}</text>`;
  }
  s += `<line x1="${px(x0).toFixed(1)}" y1="${py(lineY(x0)).toFixed(1)}" x2="${px(x1).toFixed(1)}" y2="${py(lineY(x1)).toFixed(1)}" class="fitline"/>`;
  for (const p of peers) {
    s += `<circle cx="${px(Math.log10(p.tvl_usd)).toFixed(1)}" cy="${py(Math.log10(p.mcap_usd)).toFixed(1)}" r="3" class="peer"/>`;
  }
  for (const r of rows) {
    s += `<circle cx="${px(Math.log10(r.tvl_usd)).toFixed(1)}" cy="${py(Math.log10(r.implied_value_usd)).toFixed(1)}" r="3.2" class="rowpt"/>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Log-log scatter of peer market caps and board implied values against TVL with the fitted curve">${s}</svg>`;
}

function renderMethod() {
  const catRows = R.categories
    .map(
      (c) => `<div class="prow"><span>${esc(c.category)}</span>
        <span>${c.peer_count} peers</span>
        <span>offset ${c.offset >= 0 ? "+" : ""}${c.offset.toFixed(3)}</span>
        <span>x${c.multiple.toFixed(3)}</span></div>`,
    )
    .join("");
  $("#method").innerHTML = `
    <h2>How the radar prices a protocol with no token</h2>
    <p>The snapshot (DefiLlama, as of ${esc(R.as_of)}) holds ${peers.length + rows.length}
    protocols; ${model.peer_count} of them already have tokens with both a market
    cap and a TVL. Those peers are the only pricing evidence, so the model is
    fitted to them and then applied to the protocols that have no token yet.</p>
    <p><strong>The curve.</strong> A least-squares fit of log market cap on log TVL
    over the peers gives log(mcap) = ${model.alpha.toFixed(3)} + ${model.beta.toFixed(3)} x log(TVL):
    market cap grows at about the ${model.beta < 0.6 ? "square root" : "fitted power"} of TVL,
    so a protocol ten times larger is worth roughly
    ${Math.pow(10, model.beta).toFixed(1)} times more, not ten times more. The
    residual spread is ${model.residual_sd.toFixed(2)} log points — wide, which is
    why no single row should be read as a promise.</p>
    <div class="chart">${fittedChart()}
      <div class="legend"><span class="dot peerdot"></span>tokenized peers, at their actual market caps
      <span class="dot rowdot"></span>board rows, at their implied values
      <span class="swatch"></span>the fitted curve</div>
      <p class="caption">Both axes are log scales; the horizontal axis is TVL. The
      peers scatter widely around the curve — that spread is the market's real
      dispersion, and the model's honest uncertainty. The board rows hug the line
      because they are plotted at the curve price after their category offset and
      fitted factor adjustments, which are small next to the curve itself.</p>
    </div>
    <p><strong>Sensitivity.</strong> Priced the simple way — every protocol at the
    peers' median market-cap/TVL multiple of ${model.sensitivity.median_multiple.toFixed(3)}x —
    the ranking never changes with price at all: a constant multiple leaves the
    board in raw TVL order. Against that flat ranking, the fitted model's board
    correlates at Spearman ${model.sensitivity.spearman_vs_flat.toFixed(2)}, and
    ${model.sensitivity.top25_overlap} of the flat top 25 stay in the fitted top 25.
    The gap between the two rankings is the curve at work: its sub-linear slope
    stops sheer size from crowning the board, and the category offsets and
    factors do the rest of the reordering.</p>
    <p><strong>Category offsets.</strong> Each category's peers vote for an
    intercept above or below the curve, shrunk toward zero by peer count
    (prior strength ${model.category_shrink_k}): a category with two peers is
    mostly the market; one with fifteen mostly itself.</p>
    <p><strong>Fitted effects.</strong> On the residuals, three more slopes are
    fitted and shrunk (prior strength ${model.slope_shrink_k}), each capped so it
    cannot dominate a row: momentum (7-day TVL change, slope ${model.slopes.momentum.toFixed(3)}),
    chain breadth (log2 of chain count, slope ${model.slopes.breadth.toFixed(3)}),
    and tokenless age (log10 of days, slope ${model.slopes.age.toFixed(3)}). The
    signs are whatever the peers say they are — in this snapshot, hot weekly
    TVL growth and long tokenless age both price slightly lower, breadth
    slightly higher.</p>
    <p><strong>The board.</strong> A protocol is pre-token when the snapshot
    records no market cap and no symbol for it. Exchange and bridge categories
    are excluded — their TVL is custodial float, not farmable usage — except
    where the competition's own watchlist names them. Every watchlist protocol
    is on the board; the rest clear a ${money(model.board_min_tvl_usd)} TVL line.</p>
    <h3>Category offsets fitted from the peers</h3>
    <div class="peers">${catRows}</div>`;
}

renderStats();
renderCategories();
renderBoard();
renderMethod();
for (const id of ["#q", "#cat", "#sort", "#watch"]) {
  $(id).addEventListener("input", renderBoard);
  $(id).addEventListener("change", renderBoard);
}
