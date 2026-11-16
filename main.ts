// Token Launch Radar — entrypoint.
//
// Reads the sealed DefiLlama snapshot, builds the ranked board of
// pre-token protocols with the radar-3 model (lib/model.ts), and writes
// everything the dossier needs into the output directory:
//   board.json    the ranked board, one row per protocol
//   data.js       the dashboard's data payload (window.RADAR)
//   dashboard/    the static dashboard, copied from this repository
//   screenshots/  the dashboard screenshots, copied from this repository
//   dossier.json  the sealed dossier, built by the kit's own library
//
// Paths default to the harness mounts (/input, /output) and can be
// overridden with INPUT_PATH / OUTPUT_DIR for a local run.

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoard, dashboardData, type Snapshot } from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const repoDir = dirname(fileURLToPath(import.meta.url));
const inputPath = process.env.INPUT_PATH ?? "/input/snapshot.json";
const outputDir = process.env.OUTPUT_DIR ?? "/output";

function main(): void {
  const snapshot = JSON.parse(readFileSync(inputPath, "utf8")) as Snapshot;

  const rows = buildBoard(snapshot);
  if (rows.length < 100 || rows.length > 4000) {
    throw new Error(`board has ${rows.length} rows, outside 100..4000`);
  }
  const watch = new Set(snapshot.watchlist);
  const covered = new Set(rows.map((r) => r.slug));
  for (const slug of watch) {
    if (!covered.has(slug)) throw new Error(`watchlist slug missing: ${slug}`);
  }

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    join(outputDir, "board.json"),
    `${JSON.stringify({ rows }, null, 2)}\n`,
  );
  const data = dashboardData(snapshot, rows);
  writeFileSync(
    join(outputDir, "data.js"),
    `window.RADAR=${JSON.stringify(data)};\n`,
  );

  cpSync(join(repoDir, "dashboard"), join(outputDir, "dashboard"), {
    recursive: true,
  });
  cpSync(join(repoDir, "screenshots"), join(outputDir, "screenshots"), {
    recursive: true,
  });

  const dossier = buildDossier(outputDir, {
    text_max_bytes: 65_536,
    screenshots: { max: 4, max_bytes: 512 * 1024 },
    dashboard: { max_files: 400, max_bytes: 4 * 1024 * 1024 },
  });
  writeFileSync(join(outputDir, "dossier.json"), dossier);

  const top = rows[0];
  console.log(
    `radar: ${rows.length} rows, ${watch.size} watchlist covered, ` +
      `#1 ${top.slug} at $${top.implied_value_usd.toLocaleString("en-US")}`,
  );
}

main();
