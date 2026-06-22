import fs from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.split("=");
    return [key.replace(/^--/, ""), value ?? "true"];
  }),
);

const rootDir = args.rootDir ?? "F:\\649";
const outputDir = args.outputDir ?? path.join(rootDir, "holdout_validation");
const validationStart = args.validationStart ?? "2023-01-01";
const testStart = args.testStart ?? "2025-01-01";
const testEnd = args.testEnd ?? "2026-06-18";
const warmupDraws = Number(args.warmupDraws ?? 104);
const halfLifeCandidates = (args.halfLives ?? "10,20,26,52,78,104,156,208,312")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

const gameConfigs = [
  {
    key: "lotto649",
    label: "Lotto 649",
    fileName: "lotto649_2016-06-19_to_2026-06-18.csv",
    pickCount: 6,
    mainColumns: ["main_1", "main_2", "main_3", "main_4", "main_5", "main_6"],
    poolSizeForDate() {
      return 49;
    },
  },
  {
    key: "lottomax",
    label: "Lotto Max",
    fileName: "lottomax_2016-06-19_to_2026-06-18.csv",
    pickCount: 7,
    mainColumns: ["main_1", "main_2", "main_3", "main_4", "main_5", "main_6", "main_7"],
    poolSizeForDate(drawDate) {
      if (drawDate >= "2026-04-14") return 52;
      if (drawDate >= "2019-05-14") return 50;
      return 49;
    },
  },
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }

  const headers = rows.shift();
  return rows
    .filter((values) => values.some((value) => value !== ""))
    .map((values) =>
      Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
    );
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rowsToCsv(rows, columns) {
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => escapeCsvValue(row[column])).join(",")),
  ].join("\r\n") + "\r\n";
}

function choose(n, r) {
  if (r < 0 || r > n) return 0;
  const k = Math.min(r, n - r);
  let result = 1;
  for (let i = 1; i <= k; i += 1) {
    result *= (n - k + i) / i;
  }
  return result;
}

function hypergeometricProbability(poolSize, drawnCount, pickedCount, hits) {
  return (
    (choose(drawnCount, hits) * choose(poolSize - drawnCount, pickedCount - hits)) /
    choose(poolSize, pickedCount)
  );
}

function randomStats(poolSize, pickCount) {
  const probabilities = [];
  for (let hits = 0; hits <= pickCount; hits += 1) {
    probabilities[hits] = hypergeometricProbability(poolSize, pickCount, pickCount, hits);
  }

  const expectedHits = probabilities.reduce(
    (total, probability, hits) => total + probability * hits,
    0,
  );
  const expectedHitsSquared = probabilities.reduce(
    (total, probability, hits) => total + probability * hits * hits,
    0,
  );

  const atLeast = {};
  for (let threshold = 2; threshold <= Math.min(5, pickCount); threshold += 1) {
    const probability = probabilities
      .slice(threshold)
      .reduce((total, value) => total + value, 0);
    atLeast[threshold] = {
      probability,
      variance: probability * (1 - probability),
    };
  }

  return {
    expectedHits,
    hitVariance: expectedHitsSquared - expectedHits * expectedHits,
    atLeast,
  };
}

function getMainNumbers(row, config) {
  return config.mainColumns.map((column) => Number(row[column]));
}

function createScoreMap(poolSize) {
  return Object.fromEntries(Array.from({ length: poolSize }, (_, index) => [index + 1, 0]));
}

function selectTopNumbers(scores, pickCount, lastSeen = {}) {
  return Object.entries(scores)
    .map(([number, score]) => ({
      number: Number(number),
      score,
      lastSeen: lastSeen[number] ?? -1,
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.lastSeen !== left.lastSeen) return right.lastSeen - left.lastSeen;
      return left.number - right.number;
    })
    .slice(0, pickCount)
    .map((entry) => entry.number)
    .sort((left, right) => left - right);
}

function scoreHotAll(trainingRows, config, poolSize) {
  const scores = createScoreMap(poolSize);
  const lastSeen = {};

  trainingRows.forEach((row, rowIndex) => {
    for (const number of getMainNumbers(row, config)) {
      if (number <= poolSize) {
        scores[number] += 1;
        lastSeen[number] = rowIndex;
      }
    }
  });

  return { scores, lastSeen };
}

function scoreRecencyWeighted(trainingRows, config, poolSize, halfLife) {
  const scores = createScoreMap(poolSize);
  const lastSeen = {};
  const latestIndex = trainingRows.length - 1;

  trainingRows.forEach((row, rowIndex) => {
    const age = latestIndex - rowIndex;
    const weight = Math.pow(0.5, age / halfLife);
    for (const number of getMainNumbers(row, config)) {
      if (number <= poolSize) {
        scores[number] += weight;
        lastSeen[number] = rowIndex;
      }
    }
  });

  return { scores, lastSeen };
}

function countHits(predictedNumbers, actualNumbers) {
  const actualSet = new Set(actualNumbers);
  return predictedNumbers.filter((number) => actualSet.has(number)).length;
}

function candidateList() {
  return [
    { key: "hot_all_history", strategy: "hot_all_history", label: "Hot all history" },
    ...halfLifeCandidates.map((halfLife) => ({
      key: `recency_weighted_hl${halfLife}`,
      strategy: "recency_weighted",
      half_life_draws: halfLife,
      label: `Recency weighted HL ${halfLife}`,
    })),
  ];
}

function phaseForDate(drawDate) {
  if (drawDate >= testStart && drawDate <= testEnd) return "test";
  if (drawDate >= validationStart && drawDate < testStart) return "validation";
  return "training";
}

function predictForCandidate(candidate, trainingRows, config, poolSize) {
  if (candidate.strategy === "hot_all_history") {
    return scoreHotAll(trainingRows, config, poolSize);
  }

  return scoreRecencyWeighted(trainingRows, config, poolSize, candidate.half_life_draws);
}

function zScore(actual, expected, variance) {
  if (variance <= 0) return "";
  return (actual - expected) / Math.sqrt(variance);
}

function formatNumber(value, digits = 6) {
  if (value === "" || value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "";
  }

  return Number(value).toFixed(digits).replace(/\.?0+$/, "");
}

function summarizePredictions(predictions, config, candidate, phase) {
  const summary = {
    game: config.label,
    phase,
    strategy: candidate.strategy,
    candidate_key: candidate.key,
    half_life_draws: candidate.half_life_draws ?? "",
    draws: predictions.length,
    actual_total_hits: 0,
    expected_total_hits_random: 0,
    hit_variance_random: 0,
    actual_at_least_2: 0,
    expected_at_least_2_random: 0,
    variance_at_least_2_random: 0,
    actual_at_least_3: 0,
    expected_at_least_3_random: 0,
    variance_at_least_3_random: 0,
    actual_at_least_4: 0,
    expected_at_least_4_random: 0,
    variance_at_least_4_random: 0,
  };

  for (const prediction of predictions) {
    const hits = Number(prediction.hits);
    const stats = randomStats(Number(prediction.pool_size), config.pickCount);
    summary.actual_total_hits += hits;
    summary.expected_total_hits_random += stats.expectedHits;
    summary.hit_variance_random += stats.hitVariance;

    for (const threshold of [2, 3, 4]) {
      summary[`actual_at_least_${threshold}`] += hits >= threshold ? 1 : 0;
      summary[`expected_at_least_${threshold}_random`] += stats.atLeast[threshold].probability;
      summary[`variance_at_least_${threshold}_random`] += stats.atLeast[threshold].variance;
    }
  }

  const actualAvg = summary.actual_total_hits / summary.draws;
  const expectedAvg = summary.expected_total_hits_random / summary.draws;
  return {
    game: summary.game,
    phase: summary.phase,
    strategy: summary.strategy,
    candidate_key: summary.candidate_key,
    half_life_draws: summary.half_life_draws,
    draws: summary.draws,
    actual_total_hits: summary.actual_total_hits,
    expected_total_hits_random: formatNumber(summary.expected_total_hits_random),
    avg_hits_per_draw: formatNumber(actualAvg),
    random_avg_hits_per_draw: formatNumber(expectedAvg),
    avg_hit_lift_vs_random: formatNumber(actualAvg / expectedAvg),
    total_hits_z: formatNumber(
      zScore(summary.actual_total_hits, summary.expected_total_hits_random, summary.hit_variance_random),
    ),
    actual_at_least_2: summary.actual_at_least_2,
    expected_at_least_2_random: formatNumber(summary.expected_at_least_2_random),
    at_least_2_lift_vs_random: formatNumber(
      summary.actual_at_least_2 / summary.expected_at_least_2_random,
    ),
    at_least_2_z: formatNumber(
      zScore(
        summary.actual_at_least_2,
        summary.expected_at_least_2_random,
        summary.variance_at_least_2_random,
      ),
    ),
    actual_at_least_3: summary.actual_at_least_3,
    expected_at_least_3_random: formatNumber(summary.expected_at_least_3_random),
    at_least_3_lift_vs_random: formatNumber(
      summary.actual_at_least_3 / summary.expected_at_least_3_random,
    ),
    at_least_3_z: formatNumber(
      zScore(
        summary.actual_at_least_3,
        summary.expected_at_least_3_random,
        summary.variance_at_least_3_random,
      ),
    ),
    actual_at_least_4: summary.actual_at_least_4,
    expected_at_least_4_random: formatNumber(summary.expected_at_least_4_random),
    at_least_4_lift_vs_random: formatNumber(
      summary.actual_at_least_4 / summary.expected_at_least_4_random,
    ),
    at_least_4_z: formatNumber(
      zScore(
        summary.actual_at_least_4,
        summary.expected_at_least_4_random,
        summary.variance_at_least_4_random,
      ),
    ),
  };
}

function selectBestValidationCandidate(summaryRows, gameLabel, metric) {
  const candidates = summaryRows
    .filter((row) => row.game === gameLabel && row.phase === "validation")
    .sort((left, right) => {
      const metricDiff = Number(right[metric]) - Number(left[metric]);
      if (metricDiff !== 0) return metricDiff;

      for (const tieBreaker of [
        "avg_hit_lift_vs_random",
        "at_least_2_lift_vs_random",
        "at_least_3_lift_vs_random",
      ]) {
        if (tieBreaker === metric) continue;
        const tieDiff = Number(right[tieBreaker]) - Number(left[tieBreaker]);
        if (tieDiff !== 0) return tieDiff;
      }

      return String(left.candidate_key).localeCompare(String(right.candidate_key));
    });

  return candidates[0];
}

await fs.mkdir(outputDir, { recursive: true });

const allSummaryRows = [];
const allPredictionRows = [];
const candidates = candidateList();

for (const config of gameConfigs) {
  const sourcePath = path.join(rootDir, config.fileName);
  const rows = parseCsv(await fs.readFile(sourcePath, "utf8"))
    .sort((left, right) => {
      const dateCompare = left.draw_date.localeCompare(right.draw_date);
      if (dateCompare !== 0) return dateCompare;
      return Number(left.draw_number) - Number(right.draw_number);
    });

  for (const candidate of candidates) {
    const predictionsByPhase = {
      validation: [],
      test: [],
    };

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const phase = phaseForDate(row.draw_date);
      if (phase === "training") continue;

      const trainingRows = rows.slice(0, rowIndex);
      if (trainingRows.length < warmupDraws) continue;

      const poolSize = config.poolSizeForDate(row.draw_date);
      const { scores, lastSeen } = predictForCandidate(candidate, trainingRows, config, poolSize);
      const predictedNumbers = selectTopNumbers(scores, config.pickCount, lastSeen);
      const actualNumbers = getMainNumbers(row, config);
      const hits = countHits(predictedNumbers, actualNumbers);
      const prediction = {
        game: config.label,
        phase,
        strategy: candidate.strategy,
        candidate_key: candidate.key,
        half_life_draws: candidate.half_life_draws ?? "",
        draw_date: row.draw_date,
        draw_number: row.draw_number,
        pool_size: poolSize,
        actual_numbers: actualNumbers.join("-"),
        predicted_numbers: predictedNumbers.join("-"),
        hits,
      };

      predictionsByPhase[phase].push(prediction);
      allPredictionRows.push(prediction);
    }

    for (const phase of ["validation", "test"]) {
      allSummaryRows.push(summarizePredictions(predictionsByPhase[phase], config, candidate, phase));
    }
  }
}

const selectedRows = [];
const selectionMetrics = [
  {
    key: "validation_avg_hit_lift_vs_random",
    column: "avg_hit_lift_vs_random",
    label: "validation avg_hit_lift_vs_random",
  },
  {
    key: "validation_at_least_2_lift_vs_random",
    column: "at_least_2_lift_vs_random",
    label: "validation at_least_2_lift_vs_random",
  },
];

for (const config of gameConfigs) {
  for (const selectionMetric of selectionMetrics) {
    const selected = selectBestValidationCandidate(
      allSummaryRows,
      config.label,
      selectionMetric.column,
    );
    const testRow = allSummaryRows.find(
      (row) =>
        row.game === config.label &&
        row.phase === "test" &&
        row.candidate_key === selected.candidate_key,
    );

    selectedRows.push({
      game: config.label,
      selected_candidate_key: selected.candidate_key,
      selected_strategy: selected.strategy,
      selected_half_life_draws: selected.half_life_draws,
      selection_metric: selectionMetric.label,
      validation_metric_value: selected[selectionMetric.column],
      validation_avg_hit_lift_vs_random: selected.avg_hit_lift_vs_random,
      validation_total_hits_z: selected.total_hits_z,
      validation_at_least_2_lift_vs_random: selected.at_least_2_lift_vs_random,
      test_draws: testRow.draws,
      test_avg_hit_lift_vs_random: testRow.avg_hit_lift_vs_random,
      test_total_hits_z: testRow.total_hits_z,
      test_at_least_2_lift_vs_random: testRow.at_least_2_lift_vs_random,
      test_at_least_2_z: testRow.at_least_2_z,
      test_at_least_3_lift_vs_random: testRow.at_least_3_lift_vs_random,
      test_at_least_3_z: testRow.at_least_3_z,
      test_at_least_4_lift_vs_random: testRow.at_least_4_lift_vs_random,
      test_at_least_4_z: testRow.at_least_4_z,
    });
  }
}

const summaryColumns = [
  "game",
  "phase",
  "strategy",
  "candidate_key",
  "half_life_draws",
  "draws",
  "actual_total_hits",
  "expected_total_hits_random",
  "avg_hits_per_draw",
  "random_avg_hits_per_draw",
  "avg_hit_lift_vs_random",
  "total_hits_z",
  "actual_at_least_2",
  "expected_at_least_2_random",
  "at_least_2_lift_vs_random",
  "at_least_2_z",
  "actual_at_least_3",
  "expected_at_least_3_random",
  "at_least_3_lift_vs_random",
  "at_least_3_z",
  "actual_at_least_4",
  "expected_at_least_4_random",
  "at_least_4_lift_vs_random",
  "at_least_4_z",
];

const predictionColumns = [
  "game",
  "phase",
  "strategy",
  "candidate_key",
  "half_life_draws",
  "draw_date",
  "draw_number",
  "pool_size",
  "actual_numbers",
  "predicted_numbers",
  "hits",
];

const selectedColumns = [
  "game",
  "selected_candidate_key",
  "selected_strategy",
  "selected_half_life_draws",
  "selection_metric",
  "validation_metric_value",
  "validation_avg_hit_lift_vs_random",
  "validation_total_hits_z",
  "validation_at_least_2_lift_vs_random",
  "test_draws",
  "test_avg_hit_lift_vs_random",
  "test_total_hits_z",
  "test_at_least_2_lift_vs_random",
  "test_at_least_2_z",
  "test_at_least_3_lift_vs_random",
  "test_at_least_3_z",
  "test_at_least_4_lift_vs_random",
  "test_at_least_4_z",
];

await fs.writeFile(
  path.join(outputDir, "holdout_strategy_scores.csv"),
  rowsToCsv(allSummaryRows, summaryColumns),
  "utf8",
);
await fs.writeFile(
  path.join(outputDir, "holdout_predictions.csv"),
  rowsToCsv(allPredictionRows, predictionColumns),
  "utf8",
);
await fs.writeFile(
  path.join(outputDir, "selected_holdout_test_results.csv"),
  rowsToCsv(selectedRows, selectedColumns),
  "utf8",
);
await fs.writeFile(
  path.join(outputDir, "holdout_validation_summary.json"),
  JSON.stringify(
    {
      rootDir,
      outputDir,
      validationStart,
      testStart,
      testEnd,
      warmupDraws,
      halfLifeCandidates,
      selectedRows,
    },
    null,
    2,
  ),
  "utf8",
);

console.log(JSON.stringify({
  outputDir,
  validationStart,
  testStart,
  testEnd,
  warmupDraws,
  halfLifeCandidates,
  files: [
    path.join(outputDir, "holdout_strategy_scores.csv"),
    path.join(outputDir, "holdout_predictions.csv"),
    path.join(outputDir, "selected_holdout_test_results.csv"),
    path.join(outputDir, "holdout_validation_summary.json"),
  ],
}, null, 2));
