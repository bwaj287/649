import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.split("=");
    return [key.replace(/^--/, ""), value ?? "true"];
  }),
);

const rootDir = args.rootDir ?? scriptDir;
const outputDir = args.outputDir ?? rootDir;
const yearsBack = Number(args.yearsBack ?? 10);
const skipFetch = args.skipFetch === "true";
const trainOnNewData = args.trainOnNewData !== "false";
const modelConfigPath = args.modelConfig ?? path.join(rootDir, "trained_model_config.json");
const useTrainedModelConfig = args.useTrainedModelConfig !== "false";
const lotto649HalfLife = Number(args.lotto649HalfLife ?? 26);
const lottoMaxHalfLife = Number(args.lottoMaxHalfLife ?? 208);
const defaultCombinationScoreWeights = {
  numberScore: 0.72,
  patternProfile: 0.28,
};
let trainedModelConfig = loadTrainedModelConfig();

function loadTrainedModelConfig() {
  if (!useTrainedModelConfig || !fsSync.existsSync(modelConfigPath)) return null;
  try {
    return JSON.parse(fsSync.readFileSync(modelConfigPath, "utf8"));
  } catch (error) {
    console.warn(`Could not read trained model config at ${modelConfigPath}: ${error.message}`);
    return null;
  }
}

function applyTrainedOverrides(config) {
  const override = trainedModelConfig?.games?.[config.key];
  if (!override) return config;

  return {
    ...config,
    halfLife: Number(override.halfLife ?? config.halfLife),
    minimumNonBirthdayNumbers: Number(
      override.minimumNonBirthdayNumbers ?? config.minimumNonBirthdayNumbers,
    ),
    scoreWeights: {
      ...config.scoreWeights,
      ...(override.scoreWeights ?? {}),
    },
    combinationScoreWeights: {
      ...config.combinationScoreWeights,
      ...(override.combinationScoreWeights ?? {}),
    },
    trainedConfigGeneratedAt: trainedModelConfig.generatedAt ?? "",
  };
}

function buildGameConfigs() {
  return [
    applyTrainedOverrides({
    key: "lotto649",
    label: "Lotto 649",
    pickCount: 6,
    halfLife: lotto649HalfLife,
    minimumNonBirthdayNumbers: 2,
    scoreWeights: {
      recentActivity: 0.46,
      longTermHotness: 0.34,
      coldRebound: 0.2,
    },
    combinationScoreWeights: defaultCombinationScoreWeights,
    drawDays: new Set([3, 6]),
    mainColumns: ["main_1", "main_2", "main_3", "main_4", "main_5", "main_6"],
    poolSizeForDate() {
      return 49;
    },
    }),
    applyTrainedOverrides({
    key: "lottomax",
    label: "Lotto Max",
    pickCount: 7,
    halfLife: lottoMaxHalfLife,
    minimumNonBirthdayNumbers: 2,
    scoreWeights: {
      recentActivity: 0.46,
      longTermHotness: 0.34,
      coldRebound: 0.2,
    },
    combinationScoreWeights: defaultCombinationScoreWeights,
    mainColumns: ["main_1", "main_2", "main_3", "main_4", "main_5", "main_6", "main_7"],
    poolSizeForDate(drawDate) {
      if (drawDate >= "2026-04-14") return 52;
      if (drawDate >= "2019-05-14") return 50;
      return 49;
    },
    }),
  ];
}

let gameConfigs = buildGameConfigs();

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

async function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function splitNumberList(value) {
  return String(value || "")
    .split("-")
    .map((number) => Number(number))
    .filter((number) => Number.isInteger(number));
}

function countNumberHits(predictedNumbers, actualNumbers) {
  const actualSet = new Set(actualNumbers);
  return predictedNumbers.filter((number) => actualSet.has(number));
}

function latestNewRow(rows, previousLatestDrawDate) {
  const newRows = previousLatestDrawDate
    ? rows.filter((row) => row.draw_date > previousLatestDrawDate)
    : rows;
  return newRows.at(-1) ?? null;
}

function buildPredictionAudit({ previousPredictions, rowsByGame, updateSummary, configs }) {
  const predictionsByGame = new Map(previousPredictions.map((prediction) => [
    prediction.game,
    prediction,
  ]));
  const configsByLabel = new Map(configs.map((config) => [config.label, config]));
  const summaryByGame = new Map(updateSummary.map((summary) => [summary.game, summary]));

  return configs.map((config) => {
    const update = summaryByGame.get(config.label);
    const rows = rowsByGame[config.key] ?? [];
    const previousPrediction = predictionsByGame.get(config.label);
    const comparedRow = latestNewRow(rows, update?.previousLatestDrawDate ?? "");

    if (!update || Number(update.newDrawsAfterPreviousLatest) === 0 || !comparedRow) {
      return {
        game: config.label,
        status: "no_new_data",
        message: "No new draw data; only refreshed weighted random alternatives.",
      };
    }

    if (!previousPrediction?.picks) {
      return {
        game: config.label,
        status: "missing_previous_prediction",
        comparedDrawDate: comparedRow.draw_date,
        comparedDrawNumber: comparedRow.draw_number,
        actualNumbers: getMainNumbers(comparedRow, config).join("-"),
        message: "No previous prediction was available for comparison.",
      };
    }

    const predictedNumbers = splitNumberList(previousPrediction.picks);
    const actualNumbers = getMainNumbers(comparedRow, config);
    const matchedNumbers = countNumberHits(predictedNumbers, actualNumbers);
    const hitRate = predictedNumbers.length > 0 ? matchedNumbers.length / predictedNumbers.length : 0;

    return {
      game: config.label,
      status: "compared_latest_new_draw",
      previousPredictionGeneratedAt: previousPrediction.prediction_generated_at ?? "",
      previousPredictionForDrawDate: previousPrediction.estimated_next_draw_date ?? "",
      comparedDrawDate: comparedRow.draw_date,
      comparedDrawNumber: comparedRow.draw_number,
      comparedDrawWasLatestOfNewData: true,
      newDrawsAfterPreviousLatest: update.newDrawsAfterPreviousLatest,
      predictedNumbers: predictedNumbers.join("-"),
      actualNumbers: actualNumbers.join("-"),
      matchedNumbers: matchedNumbers.join("-"),
      hits: matchedNumbers.length,
      pickCount: predictedNumbers.length,
      hitRate: hitRate.toFixed(4),
    };
  }).filter((audit) => configsByLabel.has(audit.game));
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function cloneDate(date) {
  return new Date(date.getTime());
}

function addDays(date, days) {
  const next = cloneDate(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getScheduledDates(startDateKey, endDateKey, gameKey) {
  const dates = [];
  let cursor = new Date(`${startDateKey}T12:00:00`);
  const end = new Date(`${endDateKey}T12:00:00`);

  while (cursor <= end) {
    const day = cursor.getDay();
    if (gameKey === "lotto649" && (day === 3 || day === 6)) {
      dates.push(formatDate(cursor));
    }

    if (gameKey === "lottomax") {
      const key = formatDate(cursor);
      const fridayOnly = key <= "2019-05-10" && day === 5;
      const tuesdayFriday = key >= "2019-05-14" && (day === 2 || day === 5);
      if (fridayOnly || tuesdayFriday) {
        dates.push(key);
      }
    }

    cursor = addDays(cursor, 1);
  }

  return dates;
}

function runNode(scriptPath, scriptArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...scriptArgs], {
      cwd: rootDir,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${path.basename(scriptPath)} failed with code ${code}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseLastJson(text) {
  const match = text.match(/\{[\s\S]*\}\s*$/);
  if (!match) {
    throw new Error("Could not parse JSON output from refresh script.");
  }
  return JSON.parse(match[0]);
}

async function findLatestCsv(gameKey) {
  const files = await fs.readdir(outputDir, { withFileTypes: true });
  const candidates = [];
  for (const file of files) {
    if (!file.isFile()) continue;
    if (!file.name.startsWith(`${gameKey}_`) || !file.name.endsWith(".csv")) continue;
    const fullPath = path.join(outputDir, file.name);
    const stat = await fs.stat(fullPath);
    const dateRange = file.name.match(/_(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})\.csv$/);
    candidates.push({
      fullPath,
      mtimeMs: stat.mtimeMs,
      name: file.name,
      startDate: dateRange?.[1] ?? "",
      endDate: dateRange?.[2] ?? "",
    });
  }
  candidates.sort((left, right) =>
    right.endDate.localeCompare(left.endDate) ||
    right.startDate.localeCompare(left.startDate) ||
    right.mtimeMs - left.mtimeMs
  );
  if (!candidates[0]) {
    throw new Error(`No ${gameKey} CSV found in ${outputDir}`);
  }
  return candidates[0].fullPath;
}

async function findLatestCsvOrNull(gameKey) {
  try {
    return await findLatestCsv(gameKey);
  } catch (error) {
    if (error.message.includes(`No ${gameKey} CSV found`)) return null;
    throw error;
  }
}

async function readCsvSnapshot(csvPath) {
  if (!csvPath) return null;
  const rows = parseCsv(await fs.readFile(csvPath, "utf8")).sort((left, right) => {
    const dateCompare = left.draw_date.localeCompare(right.draw_date);
    if (dateCompare !== 0) return dateCompare;
    return Number(left.draw_number) - Number(right.draw_number);
  });

  return {
    csvPath,
    rows: rows.length,
    firstDrawDate: rows[0]?.draw_date ?? "",
    lastDrawDate: rows.at(-1)?.draw_date ?? "",
    firstDrawNumber: rows[0]?.draw_number ?? "",
    lastDrawNumber: rows.at(-1)?.draw_number ?? "",
  };
}

async function collectExistingSnapshots() {
  return Object.fromEntries(
    await Promise.all(
      gameConfigs.map(async (config) => [
        config.key,
        await readCsvSnapshot(await findLatestCsvOrNull(config.key)),
      ]),
    ),
  );
}

async function refreshOfficialData() {
  if (skipFetch) {
    return {
      outputDir,
      skippedFetch: true,
      lotto649Csv: await findLatestCsv("lotto649"),
      lottoMaxCsv: await findLatestCsv("lottomax"),
    };
  }

  const scriptPath = path.join(rootDir, "fetch_wclc_lottery_history.mjs");
  const scriptArgs = [`--outputDir=${outputDir}`, `--yearsBack=${yearsBack}`];
  if (args.endDate) {
    scriptArgs.push(`--endDate=${args.endDate}`);
  }
  if (args.concurrency) {
    scriptArgs.push(`--concurrency=${args.concurrency}`);
  }
  if (args.requestDelayMs) {
    scriptArgs.push(`--requestDelayMs=${args.requestDelayMs}`);
  }

  const result = await runNode(scriptPath, scriptArgs);
  return parseLastJson(result.stdout);
}

async function trainModelIfNeeded(hasNewData) {
  if (skipFetch) {
    return { status: "skipped", reason: "local_reprediction" };
  }

  if (!hasNewData) {
    return { status: "skipped", reason: "no_new_data" };
  }

  if (!trainOnNewData) {
    return { status: "skipped", reason: "disabled" };
  }

  const trainScript = path.join(rootDir, "train_model_weights.mjs");
  const trainArgs = [`--rootDir=${outputDir}`, `--configOutput=${modelConfigPath}`];
  if (args.trainTrials) {
    trainArgs.push(`--trials=${args.trainTrials}`);
  }
  if (args.trainSamplesPerDraw) {
    trainArgs.push(`--samplesPerDraw=${args.trainSamplesPerDraw}`);
  }
  if (args.trainSeed) {
    trainArgs.push(`--seed=${args.trainSeed}`);
  }

  const result = await runNode(trainScript, trainArgs);
  const summary = parseLastJson(result.stdout);
  trainedModelConfig = loadTrainedModelConfig();
  gameConfigs = buildGameConfigs();

  return {
    status: "trained",
    generatedAt: summary.generatedAt,
    summaryPath: summary.summaryPath,
    configOutputPath: summary.configOutputPath,
    games: summary.games,
  };
}

function summarizeUpdate({ config, before, afterRows, csvPath }) {
  const after = {
    csvPath,
    rows: afterRows.length,
    firstDrawDate: afterRows[0]?.draw_date ?? "",
    lastDrawDate: afterRows.at(-1)?.draw_date ?? "",
    firstDrawNumber: afterRows[0]?.draw_number ?? "",
    lastDrawNumber: afterRows.at(-1)?.draw_number ?? "",
  };
  const newDrawsAfterPreviousLatest = before?.lastDrawDate
    ? afterRows.filter((row) => row.draw_date > before.lastDrawDate).length
    : after.rows;
  const rowsAddedByCount = before ? after.rows - before.rows : after.rows;

  return {
    game: config.label,
    mode: skipFetch ? "local_reprediction" : "official_refresh",
    status: skipFetch
      ? "used_local_data"
      : newDrawsAfterPreviousLatest > 0
        ? "new_draws_added"
        : "already_current",
    previousRows: before?.rows ?? 0,
    currentRows: after.rows,
    rowsAddedByCount,
    newDrawsAfterPreviousLatest,
    previousLatestDrawDate: before?.lastDrawDate ?? "",
    currentLatestDrawDate: after.lastDrawDate,
    previousLatestDrawNumber: before?.lastDrawNumber ?? "",
    currentLatestDrawNumber: after.lastDrawNumber,
    previousCsvPath: before?.csvPath ?? "",
    currentCsvPath: after.csvPath,
  };
}

function getMainNumbers(row, config) {
  return config.mainColumns.map((column) => Number(row[column]));
}

function normalizeMetric(entries, metricName, outputName) {
  const values = entries.map((entry) => entry[metricName]);
  const min = Math.min(...values);
  const max = Math.max(...values);

  for (const entry of entries) {
    entry[outputName] = max === min ? 0.5 : (entry[metricName] - min) / (max - min);
  }
}

function createNumberStats(poolSize) {
  return Object.fromEntries(
    Array.from({ length: poolSize }, (_, index) => {
      const number = index + 1;
      return [
        number,
        {
          number,
          recentObserved: 0,
          recentExpected: 0,
          longObserved: 0,
          longExpected: 0,
          availableDraws: 0,
          lastSeenRowIndex: -1,
          lastSeenAvailableDraw: 0,
        },
      ];
    }),
  );
}

function scoreCompositeWeighted(rows, config, poolSize) {
  const stats = createNumberStats(poolSize);
  const latestIndex = rows.length - 1;

  rows.forEach((row, rowIndex) => {
    const age = latestIndex - rowIndex;
    const weight = Math.pow(0.5, age / config.halfLife);
    const rowPoolSize = config.poolSizeForDate(row.draw_date);
    const expectedPerAvailableNumber = config.pickCount / rowPoolSize;

    for (let number = 1; number <= Math.min(poolSize, rowPoolSize); number += 1) {
      stats[number].availableDraws += 1;
      stats[number].recentExpected += weight * expectedPerAvailableNumber;
      stats[number].longExpected += expectedPerAvailableNumber;
    }

    for (const number of getMainNumbers(row, config)) {
      if (number >= 1 && number <= poolSize) {
        stats[number].recentObserved += weight;
        stats[number].longObserved += 1;
        stats[number].lastSeenRowIndex = rowIndex;
        stats[number].lastSeenAvailableDraw = stats[number].availableDraws;
      }
    }
  });

  const entries = Object.values(stats).map((entry) => {
    const expectedGap = Math.max(1, poolSize / config.pickCount);
    const coldAge = Math.max(0, entry.availableDraws - entry.lastSeenAvailableDraw);
    const recentRatio =
      entry.recentExpected > 0 ? entry.recentObserved / entry.recentExpected : 0;
    const longRatio = entry.longExpected > 0 ? entry.longObserved / entry.longExpected : 0;
    const coldRatio = Math.min(coldAge / (expectedGap * 2.5), 1.6);

    return {
      ...entry,
      recentRatio,
      longRatio,
      coldAge,
      coldRatio,
      isBirthdayNumber: entry.number <= 31,
    };
  });

  normalizeMetric(entries, "recentRatio", "recentActivityScore");
  normalizeMetric(entries, "longRatio", "longTermHotnessScore");
  normalizeMetric(entries, "coldRatio", "coldReboundScore");

  for (const entry of entries) {
    const baseScore =
      config.scoreWeights.recentActivity * entry.recentActivityScore +
      config.scoreWeights.longTermHotness * entry.longTermHotnessScore +
      config.scoreWeights.coldRebound * entry.coldReboundScore;
    const sharingPenalty = entry.isBirthdayNumber ? 0.97 : 1;
    entry.score = baseScore * sharingPenalty;
  }

  return entries
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.lastSeenRowIndex !== left.lastSeenRowIndex) {
        return right.lastSeenRowIndex - left.lastSeenRowIndex;
      }
      return left.number - right.number;
    });
}

function selectPrizeSharingAwarePicks(ranked, config) {
  const selected = ranked.slice(0, config.pickCount);
  const selectedNumbers = new Set(selected.map((entry) => entry.number));
  const minimumNonBirthdayNumbers = Math.min(
    config.minimumNonBirthdayNumbers,
    ranked.filter((entry) => !entry.isBirthdayNumber).length,
  );

  while (selected.filter((entry) => !entry.isBirthdayNumber).length < minimumNonBirthdayNumbers) {
    const replacement = ranked.find(
      (entry) => !entry.isBirthdayNumber && !selectedNumbers.has(entry.number),
    );
    const birthdayToReplace = [...selected]
      .filter((entry) => entry.isBirthdayNumber)
      .sort((left, right) => left.score - right.score)[0];

    if (!replacement || !birthdayToReplace) break;

    const replaceIndex = selected.findIndex((entry) => entry.number === birthdayToReplace.number);
    selectedNumbers.delete(birthdayToReplace.number);
    selected[replaceIndex] = replacement;
    selectedNumbers.add(replacement.number);
  }

  return selected
    .map((entry) => entry.number)
    .sort((left, right) => left - right);
}

function quantile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function countConsecutivePairs(numbers) {
  const sorted = [...numbers].sort((left, right) => left - right);
  let count = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1] + 1) count += 1;
  }
  return count;
}

function maxSameTailCount(numbers) {
  const counts = new Map();
  for (const number of numbers) {
    const tail = number % 10;
    counts.set(tail, (counts.get(tail) ?? 0) + 1);
  }
  return Math.max(...counts.values());
}

function describeCombination(numbers, poolSize, latestNumbers = []) {
  const highCutoff = Math.floor(poolSize / 2);
  const latestSet = new Set(latestNumbers);
  return {
    sum: numbers.reduce((total, number) => total + number, 0),
    oddCount: numbers.filter((number) => number % 2 !== 0).length,
    highCount: numbers.filter((number) => number > highCutoff).length,
    consecutivePairs: countConsecutivePairs(numbers),
    maxSameTail: maxSameTailCount(numbers),
    recentRepeatCount: numbers.filter((number) => latestSet.has(number)).length,
  };
}

function createPatternProfile(rows, config, poolSize) {
  const observations = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowPoolSize = config.poolSizeForDate(row.draw_date);
    const numbers = getMainNumbers(row, config);
    if (numbers.some((number) => !Number.isInteger(number) || number < 1 || number > rowPoolSize)) {
      continue;
    }

    const previousNumbers = index > 0 ? getMainNumbers(rows[index - 1], config) : [];
    observations.push(describeCombination(numbers, rowPoolSize, previousNumbers));
  }

  const metric = (name) => observations.map((entry) => entry[name]);
  const countRange = (name) => [
    Math.floor(quantile(metric(name), 0.15)),
    Math.ceil(quantile(metric(name), 0.85)),
  ];

  return {
    poolSize,
    latestNumbers: getMainNumbers(rows.at(-1), config),
    sumRange: [
      Math.round(quantile(metric("sum"), 0.15)),
      Math.round(quantile(metric("sum"), 0.85)),
    ],
    oddRange: countRange("oddCount"),
    highRange: countRange("highCount"),
    maxConsecutivePairs: Math.max(1, Math.ceil(quantile(metric("consecutivePairs"), 0.85))),
    maxSameTail: Math.max(2, Math.ceil(quantile(metric("maxSameTail"), 0.85))),
    maxRecentRepeats: Math.max(1, Math.ceil(quantile(metric("recentRepeatCount"), 0.85))),
  };
}

function rangeScore(value, lower, upper, tolerance) {
  if (value >= lower && value <= upper) return 1;
  const distance = value < lower ? lower - value : value - upper;
  return Math.max(0, 1 - distance / Math.max(1, tolerance));
}

function maxScore(value, maximum, tolerance = 1) {
  if (value <= maximum) return 1;
  return Math.max(0, 1 - (value - maximum) / Math.max(1, tolerance));
}

function scorePatternFeatures(features, profile, pickCount) {
  const scores = {
    sum: rangeScore(features.sum, profile.sumRange[0], profile.sumRange[1], pickCount * 4),
    odd: rangeScore(features.oddCount, profile.oddRange[0], profile.oddRange[1], 1),
    high: rangeScore(features.highCount, profile.highRange[0], profile.highRange[1], 1),
    consecutive: maxScore(features.consecutivePairs, profile.maxConsecutivePairs, 1),
    tail: maxScore(features.maxSameTail, profile.maxSameTail, 1),
    repeat: maxScore(features.recentRepeatCount, profile.maxRecentRepeats, 1),
  };

  return (
    0.25 * scores.sum +
    0.18 * scores.odd +
    0.18 * scores.high +
    0.15 * scores.consecutive +
    0.12 * scores.tail +
    0.12 * scores.repeat
  );
}

function createRankLookup(ranked) {
  return new Map(ranked.map((entry) => [entry.number, entry]));
}

function scoreCandidate(numbers, rankedLookup, patternProfile, config) {
  const entries = numbers.map((number) => rankedLookup.get(number)).filter(Boolean);
  const numberScore =
    entries.reduce((sum, entry) => sum + entry.score, 0) / Math.max(1, entries.length);
  const patternFeatures = describeCombination(
    numbers,
    patternProfile.poolSize,
    patternProfile.latestNumbers,
  );
  const patternScore = scorePatternFeatures(patternFeatures, patternProfile, config.pickCount);
  const combinationScoreWeights = config.combinationScoreWeights ?? defaultCombinationScoreWeights;
  const combinedScore =
    combinationScoreWeights.numberScore * numberScore +
    combinationScoreWeights.patternProfile * patternScore;

  return {
    numbers: [...numbers].sort((left, right) => left - right),
    numberScore,
    patternFeatures,
    patternScore,
    combinedScore,
  };
}

function isBetterCandidate(candidate, best) {
  if (!best) return true;
  if (candidate.combinedScore !== best.combinedScore) {
    return candidate.combinedScore > best.combinedScore;
  }
  if (candidate.numberScore !== best.numberScore) {
    return candidate.numberScore > best.numberScore;
  }
  const leftKey = candidate.numbers.join("-");
  const rightKey = best.numbers.join("-");
  return leftKey < rightKey;
}

function selectPatternAwarePicks(ranked, config, patternProfile) {
  const candidatePoolSize = Math.min(ranked.length, 24);
  const candidatePool = ranked.slice(0, candidatePoolSize);
  const rankedLookup = createRankLookup(ranked);
  const chosen = [];
  let best = null;

  function visit(startIndex) {
    if (chosen.length === config.pickCount) {
      const nonBirthdayCount = chosen.filter((entry) => !entry.isBirthdayNumber).length;
      if (nonBirthdayCount < config.minimumNonBirthdayNumbers) return;

      const candidate = scoreCandidate(
        chosen.map((entry) => entry.number),
        rankedLookup,
        patternProfile,
        config,
      );
      if (isBetterCandidate(candidate, best)) best = candidate;
      return;
    }

    const needed = config.pickCount - chosen.length;
    for (let index = startIndex; index <= candidatePool.length - needed; index += 1) {
      chosen.push(candidatePool[index]);
      visit(index + 1);
      chosen.pop();
    }
  }

  visit(0);
  if (best) return best;

  const fallback = selectPrizeSharingAwarePicks(ranked, config);
  return scoreCandidate(fallback, rankedLookup, patternProfile, config);
}

function formatPatternProfile(candidate, profile) {
  const features = candidate.patternFeatures;
  return [
    `score=${candidate.patternScore.toFixed(2)}`,
    `sum=${features.sum}(${profile.sumRange[0]}-${profile.sumRange[1]})`,
    `odd=${features.oddCount}(${profile.oddRange[0]}-${profile.oddRange[1]})`,
    `high=${features.highCount}(${profile.highRange[0]}-${profile.highRange[1]})`,
    `consecutive=${features.consecutivePairs}(max${profile.maxConsecutivePairs})`,
    `same_tail=${features.maxSameTail}(max${profile.maxSameTail})`,
    `repeat_last=${features.recentRepeatCount}(max${profile.maxRecentRepeats})`,
  ].join(";");
}

function weightedChoice(entries, exponent = 3, weightSelector = (entry) => entry.score) {
  const weightedEntries = entries.map((entry) => ({
    entry,
    weight: Math.max(weightSelector(entry), 0.0001) ** exponent,
  }));
  const totalWeight = weightedEntries.reduce((sum, item) => sum + item.weight, 0);
  let cursor = Math.random() * totalWeight;
  for (const item of weightedEntries) {
    cursor -= item.weight;
    if (cursor <= 0) return item.entry;
  }
  return weightedEntries.at(-1)?.entry;
}

function drawRawWeightedPicks(ranked, config) {
  const candidatePoolSize = Math.min(ranked.length, Math.max(config.pickCount * 5, 28));
  const remaining = ranked.slice(0, candidatePoolSize);
  const selected = [];

  while (selected.length < config.pickCount && remaining.length > 0) {
    const pick = weightedChoice(remaining);
    const index = remaining.findIndex((entry) => entry.number === pick.number);
    selected.push(pick);
    remaining.splice(index, 1);
  }

  const minimumNonBirthdayNumbers = Math.min(
    config.minimumNonBirthdayNumbers,
    ranked.filter((entry) => !entry.isBirthdayNumber).length,
  );

  while (selected.filter((entry) => !entry.isBirthdayNumber).length < minimumNonBirthdayNumbers) {
    const selectedNumbers = new Set(selected.map((entry) => entry.number));
    const replacementPool = ranked
      .filter((entry) => !entry.isBirthdayNumber && !selectedNumbers.has(entry.number))
      .slice(0, candidatePoolSize);
    const birthdayToReplace = [...selected]
      .filter((entry) => entry.isBirthdayNumber)
      .sort((left, right) => left.score - right.score)[0];
    const replacement = weightedChoice(replacementPool);

    if (!replacement || !birthdayToReplace) break;

    const replaceIndex = selected.findIndex((entry) => entry.number === birthdayToReplace.number);
    selected[replaceIndex] = replacement;
  }

  return selected
    .map((entry) => entry.number)
    .sort((left, right) => left - right);
}

function selectWeightedRandomPicks(ranked, config, patternProfile) {
  const rankedLookup = createRankLookup(ranked);
  const candidates = [];
  const seen = new Set();

  for (let attempt = 0; attempt < 45; attempt += 1) {
    const numbers = drawRawWeightedPicks(ranked, config);
    const key = numbers.join("-");
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(scoreCandidate(numbers, rankedLookup, patternProfile, config));
  }

  return weightedChoice(candidates, 4, (candidate) => candidate.combinedScore) ?? candidates[0];
}

function buildWeightedRandomAlternatives(ranked, config, stablePicks, patternProfile, count = 5) {
  const alternatives = [];
  const seen = new Set([stablePicks.join("-")]);
  const maxAttempts = count * 80;

  for (let attempt = 0; attempt < maxAttempts && alternatives.length < count; attempt += 1) {
    const candidate = selectWeightedRandomPicks(ranked, config, patternProfile);
    const key = candidate.numbers.join("-");
    if (seen.has(key)) continue;
    seen.add(key);
    alternatives.push(candidate);
  }

  return alternatives;
}

function nextDrawDate(gameKey, latestDateKey) {
  const valid = gameKey === "lotto649" ? new Set([3, 6]) : new Set([2, 5]);
  let cursor = addDays(new Date(`${latestDateKey}T12:00:00`), 1);
  while (!valid.has(cursor.getDay())) {
    cursor = addDays(cursor, 1);
  }
  return formatDate(cursor);
}

function validateRows(rows, config, csvPath, startDateKey, endDateKey) {
  const byDate = new Map();
  const byDrawNumber = new Map();
  const invalidRows = [];
  const duplicateMainNumberRows = [];
  const criticalBlankRows = [];

  for (const row of rows) {
    byDate.set(row.draw_date, (byDate.get(row.draw_date) ?? 0) + 1);
    byDrawNumber.set(row.draw_number, (byDrawNumber.get(row.draw_number) ?? 0) + 1);

    const numbers = getMainNumbers(row, config);
    const poolSize = config.poolSizeForDate(row.draw_date);
    if (numbers.some((number) => !Number.isInteger(number) || number < 1 || number > poolSize)) {
      invalidRows.push(row.draw_number);
    }
    if (new Set(numbers).size !== numbers.length) {
      duplicateMainNumberRows.push(row.draw_number);
    }
    if (!row.draw_date || !row.draw_number || numbers.some((number) => !number)) {
      criticalBlankRows.push(row.draw_number || row.draw_date || "(unknown)");
    }
  }

  const scheduledDates =
    startDateKey && endDateKey ? getScheduledDates(startDateKey, endDateKey, config.key) : [];
  const dateSet = new Set(rows.map((row) => row.draw_date));
  const missingDates = scheduledDates.filter((dateKey) => !dateSet.has(dateKey));
  const duplicateDates = [...byDate].filter(([, count]) => count > 1).map(([dateKey]) => dateKey);
  const duplicateDrawNumbers = [...byDrawNumber]
    .filter(([, count]) => count > 1)
    .map(([drawNumber]) => drawNumber);

  return {
    game: config.label,
    csvPath,
    rows: rows.length,
    firstDrawDate: rows[0]?.draw_date ?? "",
    lastDrawDate: rows.at(-1)?.draw_date ?? "",
    firstDrawNumber: rows[0]?.draw_number ?? "",
    lastDrawNumber: rows.at(-1)?.draw_number ?? "",
    expectedScheduledRows: scheduledDates.length,
    missingScheduledDates: missingDates.length,
    duplicateDates: duplicateDates.length,
    duplicateDrawNumbers: duplicateDrawNumbers.length,
    invalidMainNumberRows: invalidRows.length,
    duplicateMainNumberRows: duplicateMainNumberRows.length,
    criticalBlankRows: criticalBlankRows.length,
    status:
      missingDates.length === 0 &&
      duplicateDates.length === 0 &&
      duplicateDrawNumbers.length === 0 &&
      invalidRows.length === 0 &&
      duplicateMainNumberRows.length === 0 &&
      criticalBlankRows.length === 0
        ? "ok"
        : "check",
    details: {
      missingDates: missingDates.slice(0, 20),
      duplicateDates: duplicateDates.slice(0, 20),
      duplicateDrawNumbers: duplicateDrawNumbers.slice(0, 20),
      invalidRows: invalidRows.slice(0, 20),
      duplicateMainNumberRows: duplicateMainNumberRows.slice(0, 20),
      criticalBlankRows: criticalBlankRows.slice(0, 20),
    },
  };
}

function predictionForGame(rows, config, predictionGeneratedAt) {
  const latestRow = rows.at(-1);
  const predictionDate = nextDrawDate(config.key, latestRow.draw_date);
  const poolSize = config.poolSizeForDate(predictionDate);
  const ranked = scoreCompositeWeighted(rows, config, poolSize);
  const patternProfile = createPatternProfile(rows, config, poolSize);
  const selectedCandidate = selectPatternAwarePicks(ranked, config, patternProfile);
  const picks = selectedCandidate.numbers;
  const weightedRandomAlternatives = buildWeightedRandomAlternatives(
    ranked,
    config,
    picks,
    patternProfile,
  );
  const nonBirthdayCount = picks.filter((number) => number > 31).length;
  const latestWinningNumbers = getMainNumbers(latestRow, config).join("-");

  return {
    game: config.label,
    prediction_generated_at: predictionGeneratedAt,
    prediction_for_next_draw_after: latestRow.draw_date,
    estimated_next_draw_date: predictionDate,
    latest_draw_date: latestRow.draw_date,
    latest_draw_number: latestRow.draw_number,
    latest_winning_numbers: latestWinningNumbers,
    latest_bonus_number: latestRow.bonus_number ?? "",
    model: config.trainedConfigGeneratedAt
      ? "composite_weighted_v3_pattern_profile_trained"
      : "composite_weighted_v3_pattern_profile",
    trained_config_generated_at: config.trainedConfigGeneratedAt ?? "",
    half_life_draws: config.halfLife,
    model_weights: `recent_activity=${config.scoreWeights.recentActivity};long_term_hotness=${config.scoreWeights.longTermHotness};cold_rebound=${config.scoreWeights.coldRebound};number_score=${config.combinationScoreWeights.numberScore};pattern_profile=${config.combinationScoreWeights.patternProfile}`,
    birthday_sharing_rule: `minimum_${config.minimumNonBirthdayNumbers}_numbers_above_31`,
    non_birthday_count: nonBirthdayCount,
    pool_size: poolSize,
    pattern_score: selectedCandidate.patternScore.toFixed(4),
    pattern_profile: formatPatternProfile(selectedCandidate, patternProfile),
    picks: picks.join("-"),
    weighted_random_alternatives: weightedRandomAlternatives
      .map((alternative) => alternative.numbers.join("-"))
      .join(";"),
    top_12_weighted_numbers: ranked
      .slice(0, 12)
      .map(
        (entry) =>
          `${entry.number}:${entry.score.toFixed(4)}(R${entry.recentActivityScore.toFixed(2)},H${entry.longTermHotnessScore.toFixed(2)},C${entry.coldReboundScore.toFixed(2)})`,
      )
      .join(";"),
  };
}

const previousPredictionsPath = path.join(outputDir, "latest_weighted_predictions.json");
const previousPredictions = await readJsonIfExists(previousPredictionsPath, []);
const beforeSnapshots = await collectExistingSnapshots();
const refresh = await refreshOfficialData();
const startDateKey = refresh.startDate ?? "";
const endDateKey = refresh.effectiveEndDate ?? "";

const csvPaths = {
  lotto649: refresh.lotto649Csv,
  lottomax: refresh.lottoMaxCsv,
};

const validationReports = [];
const predictionRows = [];
const updateSummary = [];
const rowsByGame = {};
const predictionGeneratedAt = new Date().toISOString();

for (const config of gameConfigs) {
  const csvPath = csvPaths[config.key];
  const rows = parseCsv(await fs.readFile(csvPath, "utf8")).sort((left, right) => {
    const dateCompare = left.draw_date.localeCompare(right.draw_date);
    if (dateCompare !== 0) return dateCompare;
    return Number(left.draw_number) - Number(right.draw_number);
  });
  rowsByGame[config.key] = rows;

  updateSummary.push(
    summarizeUpdate({
      config,
      before: beforeSnapshots[config.key],
      afterRows: rows,
      csvPath,
    }),
  );
  validationReports.push(
    validateRows(
      rows,
      config,
      csvPath,
      startDateKey || rows[0]?.draw_date,
      endDateKey || rows.at(-1)?.draw_date,
    ),
  );
}

const predictionAudit = buildPredictionAudit({
  previousPredictions,
  rowsByGame,
  updateSummary,
  configs: gameConfigs,
});
const hasNewOfficialData =
  !skipFetch && updateSummary.some((summary) => Number(summary.newDrawsAfterPreviousLatest) > 0);
const trainingRun = await trainModelIfNeeded(hasNewOfficialData);

for (const config of gameConfigs) {
  predictionRows.push(predictionForGame(rowsByGame[config.key], config, predictionGeneratedAt));
}

const predictionColumns = [
  "game",
  "prediction_generated_at",
  "prediction_for_next_draw_after",
  "estimated_next_draw_date",
  "latest_draw_date",
  "latest_draw_number",
  "latest_winning_numbers",
  "latest_bonus_number",
  "model",
  "trained_config_generated_at",
  "half_life_draws",
  "model_weights",
  "birthday_sharing_rule",
  "non_birthday_count",
  "pool_size",
  "pattern_score",
  "pattern_profile",
  "picks",
  "weighted_random_alternatives",
  "top_12_weighted_numbers",
];

const latestPredictionsCsv = path.join(outputDir, "latest_weighted_predictions.csv");
const latestPredictionsJson = path.join(outputDir, "latest_weighted_predictions.json");
const refreshReportJson = path.join(outputDir, "refresh_report.json");
const latestPredictionsTxt = path.join(outputDir, "latest_weighted_predictions.txt");

await fs.writeFile(latestPredictionsCsv, rowsToCsv(predictionRows, predictionColumns), "utf8");
await fs.writeFile(latestPredictionsJson, JSON.stringify(predictionRows, null, 2), "utf8");
await fs.writeFile(
  refreshReportJson,
  JSON.stringify(
    {
      refreshedAt: predictionGeneratedAt,
      refresh,
      updateSummary,
      predictionAudit,
      trainingRun,
      validationReports,
      predictionFiles: {
        csv: latestPredictionsCsv,
        json: latestPredictionsJson,
        text: latestPredictionsTxt,
      },
    },
    null,
    2,
  ),
  "utf8",
);
await fs.writeFile(
  latestPredictionsTxt,
  `Prediction generated at: ${predictionGeneratedAt}\r\n` +
    predictionRows.map((row) => `${row.game}: ${row.picks}`).join("\r\n") +
    "\r\n",
  "utf8",
);

console.log(
  JSON.stringify(
    {
      outputDir,
      refreshedCsvs: csvPaths,
      updateSummary,
      predictionAudit,
      trainingRun,
      validationReports,
      predictions: predictionRows.map((row) => ({
        game: row.game,
        predictionGeneratedAt: row.prediction_generated_at,
        nextDrawDate: row.estimated_next_draw_date,
        halfLifeDraws: row.half_life_draws,
        patternScore: row.pattern_score,
        picks: row.picks,
        weightedRandomAlternatives: row.weighted_random_alternatives,
      })),
      files: {
        latestPredictionsCsv,
        latestPredictionsJson,
        latestPredictionsTxt,
        refreshReportJson,
      },
    },
    null,
    2,
  ),
);
