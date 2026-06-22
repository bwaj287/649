import fs from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.split("=");
    return [key.replace(/^--/, ""), value ?? "true"];
  }),
);

const rootDir = args.rootDir ?? "F:\\649";
const outputDir = args.outputDir ?? path.join(rootDir, "backtest_results");
const warmupDraws = Number(args.warmupDraws ?? 104);
const halfLifeDraws = Number(args.halfLifeDraws ?? 52);

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
      if (drawDate >= "2026-04-14") {
        return 52;
      }

      if (drawDate >= "2019-05-14") {
        return 50;
      }

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
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function rowsToCsv(rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsvValue(row[column])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function choose(n, r) {
  if (r < 0 || r > n) {
    return 0;
  }

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
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (right.lastSeen !== left.lastSeen) {
        return right.lastSeen - left.lastSeen;
      }

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

function addDistributionHit(distribution, hits, pickCount) {
  for (let count = 0; count <= pickCount; count += 1) {
    distribution[count] ??= 0;
  }

  distribution[hits] += 1;
}

function summarizeStrategy(predictions, pickCount, strategyKey, randomExpected) {
  const relevant = predictions.filter((row) => row.strategy === strategyKey);
  const distribution = Object.fromEntries(Array.from({ length: pickCount + 1 }, (_, index) => [index, 0]));
  let totalHits = 0;

  for (const row of relevant) {
    const hits = Number(row.hits);
    totalHits += hits;
    addDistributionHit(distribution, hits, pickCount);
  }

  const atLeast = {};
  const lifts = {};
  for (let threshold = 2; threshold <= pickCount; threshold += 1) {
    const observed = relevant.filter((row) => Number(row.hits) >= threshold).length;
    const expected = randomExpected.at_least[threshold];
    atLeast[threshold] = observed;
    lifts[threshold] = expected > 0 ? observed / expected : null;
  }

  return {
    strategy: strategyKey,
    test_draws: relevant.length,
    total_hits: totalHits,
    avg_hits_per_draw: totalHits / relevant.length,
    hit_distribution: distribution,
    at_least: atLeast,
    lift_vs_random_at_least: lifts,
  };
}

function expectedRandomSummary(testRows, config) {
  const distribution = Object.fromEntries(Array.from({ length: config.pickCount + 1 }, (_, index) => [index, 0]));
  let totalHits = 0;

  for (const row of testRows) {
    const poolSize = config.poolSizeForDate(row.draw_date);
    for (let hits = 0; hits <= config.pickCount; hits += 1) {
      const probability = hypergeometricProbability(poolSize, config.pickCount, config.pickCount, hits);
      distribution[hits] += probability;
      totalHits += hits * probability;
    }
  }

  const atLeast = {};
  for (let threshold = 2; threshold <= config.pickCount; threshold += 1) {
    atLeast[threshold] = Object.entries(distribution)
      .filter(([hits]) => Number(hits) >= threshold)
      .reduce((sum, [, expectedCount]) => sum + expectedCount, 0);
  }

  return {
    strategy: "pure_random_expected",
    test_draws: testRows.length,
    total_hits: totalHits,
    avg_hits_per_draw: totalHits / testRows.length,
    hit_distribution: distribution,
    at_least: atLeast,
  };
}

async function loadGameRows(config) {
  const filePath = path.join(rootDir, config.fileName);
  const text = await fs.readFile(filePath, "utf8");
  return parseCsv(text).sort((left, right) => left.draw_date.localeCompare(right.draw_date));
}

function backtestGame(rows, config) {
  const predictions = [];
  const testRows = rows.slice(warmupDraws);

  for (let rowIndex = warmupDraws; rowIndex < rows.length; rowIndex += 1) {
    const targetRow = rows[rowIndex];
    const trainingRows = rows.slice(0, rowIndex);
    const actualNumbers = getMainNumbers(targetRow, config);
    const poolSize = config.poolSizeForDate(targetRow.draw_date);

    const hotAll = scoreHotAll(trainingRows, config, poolSize);
    const hotPick = selectTopNumbers(hotAll.scores, config.pickCount, hotAll.lastSeen);

    const weighted = scoreRecencyWeighted(trainingRows, config, poolSize, halfLifeDraws);
    const weightedPick = selectTopNumbers(weighted.scores, config.pickCount, weighted.lastSeen);

    const strategies = [
      { key: "hot_all_history", pick: hotPick },
      { key: "recency_weighted", pick: weightedPick },
    ];

    for (const strategy of strategies) {
      predictions.push({
        game: config.label,
        strategy: strategy.key,
        draw_date: targetRow.draw_date,
        draw_number: targetRow.draw_number,
        pool_size: poolSize,
        actual_numbers: actualNumbers.join("-"),
        predicted_numbers: strategy.pick.join("-"),
        hits: countHits(strategy.pick, actualNumbers),
      });
    }
  }

  const randomExpected = expectedRandomSummary(testRows, config);
  const summaries = [
    randomExpected,
    summarizeStrategy(predictions, config.pickCount, "hot_all_history", randomExpected),
    summarizeStrategy(predictions, config.pickCount, "recency_weighted", randomExpected),
  ];

  return { predictions, summaries, testRows };
}

function flattenSummary(gameLabel, summary) {
  const row = {
    game: gameLabel,
    strategy: summary.strategy,
    test_draws: summary.test_draws,
    total_hits: Number(summary.total_hits.toFixed(4)),
    avg_hits_per_draw: Number(summary.avg_hits_per_draw.toFixed(6)),
  };

  for (const [hits, count] of Object.entries(summary.hit_distribution)) {
    row[`hit_${hits}`] = Number(count.toFixed(4));
  }

  for (const [threshold, count] of Object.entries(summary.at_least)) {
    row[`at_least_${threshold}`] = Number(count.toFixed(4));
  }

  if (summary.lift_vs_random_at_least) {
    for (const [threshold, lift] of Object.entries(summary.lift_vs_random_at_least)) {
      row[`lift_at_least_${threshold}`] = lift === null ? "" : Number(lift.toFixed(4));
    }
  }

  return row;
}

await fs.mkdir(outputDir, { recursive: true });

const fullSummary = {
  generated_at: new Date().toISOString(),
  warmup_draws: warmupDraws,
  half_life_draws: halfLifeDraws,
  games: {},
};
const summaryRows = [];

for (const config of gameConfigs) {
  const rows = await loadGameRows(config);
  const { predictions, summaries, testRows } = backtestGame(rows, config);

  fullSummary.games[config.key] = {
    label: config.label,
    source_rows: rows.length,
    test_draws: testRows.length,
    first_test_draw_date: testRows[0]?.draw_date ?? "",
    last_test_draw_date: testRows[testRows.length - 1]?.draw_date ?? "",
    summaries,
  };

  for (const summary of summaries) {
    summaryRows.push(flattenSummary(config.label, summary));
  }

  await fs.writeFile(
    path.join(outputDir, `${config.key}_predictions.csv`),
    rowsToCsv(predictions, [
      "game",
      "strategy",
      "draw_date",
      "draw_number",
      "pool_size",
      "actual_numbers",
      "predicted_numbers",
      "hits",
    ]),
    "utf8",
  );
}

const summaryColumns = Array.from(new Set(summaryRows.flatMap((row) => Object.keys(row))));
await fs.writeFile(
  path.join(outputDir, "lottery_backtest_summary.csv"),
  rowsToCsv(summaryRows, summaryColumns),
  "utf8",
);
await fs.writeFile(
  path.join(outputDir, "lottery_backtest_summary.json"),
  `${JSON.stringify(fullSummary, null, 2)}\n`,
  "utf8",
);

console.log(
  JSON.stringify(
    {
      outputDir,
      warmupDraws,
      halfLifeDraws,
      summaryCsv: path.join(outputDir, "lottery_backtest_summary.csv"),
      summaryJson: path.join(outputDir, "lottery_backtest_summary.json"),
      games: Object.fromEntries(
        Object.entries(fullSummary.games).map(([key, value]) => [
          key,
          {
            label: value.label,
            sourceRows: value.source_rows,
            testDraws: value.test_draws,
            firstTestDrawDate: value.first_test_draw_date,
            lastTestDrawDate: value.last_test_draw_date,
          },
        ]),
      ),
    },
    null,
    2,
  ),
);
