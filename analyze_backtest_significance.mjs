import fs from "node:fs";
import path from "node:path";

const rootDir = "F:\\649";
const runs = [
  { label: "hl20", halfLifeDraws: 20, dir: path.join(rootDir, "backtest_results_hl20") },
  { label: "hl52", halfLifeDraws: 52, dir: path.join(rootDir, "backtest_results") },
  { label: "hl104", halfLifeDraws: 104, dir: path.join(rootDir, "backtest_results_hl104") },
  { label: "hl208", halfLifeDraws: 208, dir: path.join(rootDir, "backtest_results_hl208") },
];

const games = [
  { name: "Lotto 649", file: "lotto649_predictions.csv", pickCount: 6 },
  { name: "Lotto Max", file: "lottomax_predictions.csv", pickCount: 7 },
];

function parseCsv(text) {
  const rows = [];
  let current = "";
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(current);
      current = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i++;
      row.push(current);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      current = "";
    } else {
      current += char;
    }
  }

  if (current.length || row.length) {
    row.push(current);
    if (row.some((value) => value !== "")) rows.push(row);
  }

  const [headers, ...records] = rows;
  return records.map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\n") + "\n";
}

function comb(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= k; i++) {
    result = (result * (n - k + i)) / i;
  }
  return result;
}

function hypergeomProb({ populationSize, successStates, draws, hits }) {
  return (comb(successStates, hits) * comb(populationSize - successStates, draws - hits)) / comb(populationSize, draws);
}

function randomStats(poolSize, pickCount) {
  const probs = [];
  for (let hits = 0; hits <= pickCount; hits++) {
    probs[hits] = hypergeomProb({
      populationSize: poolSize,
      successStates: pickCount,
      draws: pickCount,
      hits,
    });
  }

  const expectedHits = probs.reduce((sum, probability, hits) => sum + hits * probability, 0);
  const expectedHits2 = probs.reduce((sum, probability, hits) => sum + hits * hits * probability, 0);
  const hitVariance = expectedHits2 - expectedHits * expectedHits;

  const atLeast = {};
  for (let threshold = 2; threshold <= Math.min(5, pickCount); threshold++) {
    const probability = probs.slice(threshold).reduce((sum, value) => sum + value, 0);
    atLeast[threshold] = { probability, variance: probability * (1 - probability) };
  }

  return { expectedHits, hitVariance, atLeast };
}

function summarize(rows, options = {}) {
  const total = {
    draws: rows.length,
    actualHits: 0,
    expectedHits: 0,
    hitVariance: 0,
    actualAtLeast2: 0,
    expectedAtLeast2: 0,
    varianceAtLeast2: 0,
    actualAtLeast3: 0,
    expectedAtLeast3: 0,
    varianceAtLeast3: 0,
    actualAtLeast4: 0,
    expectedAtLeast4: 0,
    varianceAtLeast4: 0,
  };

  for (const row of rows) {
    const hits = Number(row.hits);
    const poolSize = Number(row.pool_size);
    const stats = randomStats(poolSize, options.pickCount);

    total.actualHits += hits;
    total.expectedHits += stats.expectedHits;
    total.hitVariance += stats.hitVariance;

    for (const threshold of [2, 3, 4]) {
      total[`actualAtLeast${threshold}`] += hits >= threshold ? 1 : 0;
      total[`expectedAtLeast${threshold}`] += stats.atLeast[threshold].probability;
      total[`varianceAtLeast${threshold}`] += stats.atLeast[threshold].variance;
    }
  }

  return total;
}

function zScore(actual, expected, variance) {
  if (variance <= 0) return "";
  return (actual - expected) / Math.sqrt(variance);
}

function formatNumber(value, digits = 4) {
  if (value === "") return "";
  return Number(value).toFixed(digits).replace(/\.?0+$/, "");
}

const significanceRows = [];
const yearlyRows = [];

for (const run of runs) {
  for (const game of games) {
    const filePath = path.join(run.dir, game.file);
    const rows = parseCsv(fs.readFileSync(filePath, "utf8"));

    for (const strategy of ["hot_all_history", "recency_weighted"]) {
      if (strategy === "hot_all_history" && run.label !== "hl52") continue;

      const strategyRows = rows.filter((row) => row.strategy === strategy);
      const summary = summarize(strategyRows, { pickCount: game.pickCount });

      significanceRows.push({
        game: game.name,
        strategy,
        half_life_draws: strategy === "recency_weighted" ? run.halfLifeDraws : "",
        draws: summary.draws,
        actual_total_hits: summary.actualHits,
        expected_total_hits_random: formatNumber(summary.expectedHits),
        avg_hit_lift_vs_random: formatNumber((summary.actualHits / summary.draws) / (summary.expectedHits / summary.draws)),
        total_hits_z: formatNumber(zScore(summary.actualHits, summary.expectedHits, summary.hitVariance)),
        actual_at_least_2: summary.actualAtLeast2,
        expected_at_least_2_random: formatNumber(summary.expectedAtLeast2),
        at_least_2_lift_vs_random: formatNumber(summary.actualAtLeast2 / summary.expectedAtLeast2),
        at_least_2_z: formatNumber(zScore(summary.actualAtLeast2, summary.expectedAtLeast2, summary.varianceAtLeast2)),
        actual_at_least_3: summary.actualAtLeast3,
        expected_at_least_3_random: formatNumber(summary.expectedAtLeast3),
        at_least_3_lift_vs_random: formatNumber(summary.actualAtLeast3 / summary.expectedAtLeast3),
        at_least_3_z: formatNumber(zScore(summary.actualAtLeast3, summary.expectedAtLeast3, summary.varianceAtLeast3)),
        actual_at_least_4: summary.actualAtLeast4,
        expected_at_least_4_random: formatNumber(summary.expectedAtLeast4),
        at_least_4_lift_vs_random: formatNumber(summary.actualAtLeast4 / summary.expectedAtLeast4),
        at_least_4_z: formatNumber(zScore(summary.actualAtLeast4, summary.expectedAtLeast4, summary.varianceAtLeast4)),
      });

      const rowsByYear = Map.groupBy(strategyRows, (row) => row.draw_date.slice(0, 4));
      for (const [year, yearRows] of [...rowsByYear].sort(([a], [b]) => a.localeCompare(b))) {
        const yearSummary = summarize(yearRows, { pickCount: game.pickCount });
        yearlyRows.push({
          game: game.name,
          strategy,
          half_life_draws: strategy === "recency_weighted" ? run.halfLifeDraws : "",
          year,
          draws: yearSummary.draws,
          actual_total_hits: yearSummary.actualHits,
          expected_total_hits_random: formatNumber(yearSummary.expectedHits),
          avg_hit_lift_vs_random: formatNumber((yearSummary.actualHits / yearSummary.draws) / (yearSummary.expectedHits / yearSummary.draws)),
          actual_at_least_2: yearSummary.actualAtLeast2,
          expected_at_least_2_random: formatNumber(yearSummary.expectedAtLeast2),
          at_least_2_lift_vs_random: formatNumber(yearSummary.actualAtLeast2 / yearSummary.expectedAtLeast2),
          actual_at_least_3: yearSummary.actualAtLeast3,
          expected_at_least_3_random: formatNumber(yearSummary.expectedAtLeast3),
          at_least_3_lift_vs_random: formatNumber(yearSummary.actualAtLeast3 / yearSummary.expectedAtLeast3),
        });
      }
    }
  }
}

const outputDir = path.join(rootDir, "backtest_results");
fs.writeFileSync(path.join(outputDir, "strategy_significance.csv"), toCsv(significanceRows), "utf8");
fs.writeFileSync(path.join(outputDir, "yearly_strategy_performance.csv"), toCsv(yearlyRows), "utf8");

console.log(JSON.stringify({
  outputDir,
  files: [
    path.join(outputDir, "strategy_significance.csv"),
    path.join(outputDir, "yearly_strategy_performance.csv"),
  ],
}, null, 2));
