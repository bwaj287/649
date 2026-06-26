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
const outputDir = args.outputDir ?? path.join(rootDir, "train_results");
const configOutputPath = args.configOutput ?? path.join(rootDir, "trained_model_config.json");
const validationStart = args.validationStart ?? "2023-01-01";
const testStart = args.testStart ?? "2025-01-01";
const testEndArg = args.testEnd ?? "";
const warmupDraws = Number(args.warmupDraws ?? 104);
const trials = Number(args.trials ?? 160);
const samplesPerDraw = Number(args.samplesPerDraw ?? 32);
const writeConfig = args.writeConfig !== "false";
const seed = Number(args.seed ?? 649);
const halfLifeCandidates = (args.halfLives ?? "13,20,26,39,52,78,104,156,208,312")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

const defaultCombinationScoreWeights = {
  numberScore: 0.72,
  patternProfile: 0.28,
};

const gameConfigs = [
  {
    key: "lotto649",
    label: "Lotto 649",
    pickCount: 6,
    defaultHalfLife: 26,
    defaultMinimumNonBirthdayNumbers: 2,
    mainColumns: ["main_1", "main_2", "main_3", "main_4", "main_5", "main_6"],
    poolSizeForDate() {
      return 49;
    },
  },
  {
    key: "lottomax",
    label: "Lotto Max",
    pickCount: 7,
    defaultHalfLife: 208,
    defaultMinimumNonBirthdayNumbers: 2,
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

function round(value, digits = 6) {
  if (!Number.isFinite(Number(value))) return value;
  return Number(value).toFixed(digits);
}

function createRng(initialSeed) {
  let state = initialSeed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function hashString(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function findLatestCsv(gameKey) {
  const files = await fs.readdir(rootDir, { withFileTypes: true });
  const candidates = [];
  for (const file of files) {
    if (!file.isFile()) continue;
    if (!file.name.startsWith(`${gameKey}_`) || !file.name.endsWith(".csv")) continue;
    const fullPath = path.join(rootDir, file.name);
    const stat = await fs.stat(fullPath);
    const dateRange = file.name.match(/_(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})\.csv$/);
    candidates.push({
      fullPath,
      name: file.name,
      mtimeMs: stat.mtimeMs,
      startDate: dateRange?.[1] ?? "",
      endDate: dateRange?.[2] ?? "",
    });
  }

  candidates.sort((left, right) =>
    right.endDate.localeCompare(left.endDate) ||
    right.startDate.localeCompare(left.startDate) ||
    right.mtimeMs - left.mtimeMs
  );

  if (!candidates[0]) throw new Error(`No ${gameKey} CSV found in ${rootDir}`);
  return candidates[0];
}

function getMainNumbers(row, config) {
  return config.mainColumns.map((column) => Number(row[column]));
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

function normalizeMetric(entries, metricName, outputName) {
  const values = entries.map((entry) => entry[metricName]);
  const min = Math.min(...values);
  const max = Math.max(...values);

  for (const entry of entries) {
    entry[outputName] = max === min ? 0.5 : (entry[metricName] - min) / (max - min);
  }
}

function scoreCompositeWeighted(rows, config, candidate, poolSize) {
  const stats = createNumberStats(poolSize);
  const latestIndex = rows.length - 1;

  rows.forEach((row, rowIndex) => {
    const age = latestIndex - rowIndex;
    const weight = Math.pow(0.5, age / candidate.halfLife);
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
      candidate.scoreWeights.recentActivity * entry.recentActivityScore +
      candidate.scoreWeights.longTermHotness * entry.longTermHotnessScore +
      candidate.scoreWeights.coldRebound * entry.coldReboundScore;
    const sharingPenalty = entry.isBirthdayNumber ? 0.97 : 1;
    entry.score = baseScore * sharingPenalty;
  }

  return entries.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.lastSeenRowIndex !== left.lastSeenRowIndex) {
      return right.lastSeenRowIndex - left.lastSeenRowIndex;
    }
    return left.number - right.number;
  });
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

function scoreCandidate(numbers, rankedLookup, patternProfile, config, candidate) {
  const entries = numbers.map((number) => rankedLookup.get(number)).filter(Boolean);
  const numberScore =
    entries.reduce((sum, entry) => sum + entry.score, 0) / Math.max(1, entries.length);
  const patternFeatures = describeCombination(
    numbers,
    patternProfile.poolSize,
    patternProfile.latestNumbers,
  );
  const patternScore = scorePatternFeatures(patternFeatures, patternProfile, config.pickCount);
  const combinedScore =
    candidate.combinationScoreWeights.numberScore * numberScore +
    candidate.combinationScoreWeights.patternProfile * patternScore;

  return {
    numbers: [...numbers].sort((left, right) => left - right),
    numberScore,
    patternScore,
    combinedScore,
  };
}

function weightedChoice(entries, rng, exponent = 3, weightSelector = (entry) => entry.score) {
  const weightedEntries = entries.map((entry) => ({
    entry,
    weight: Math.max(weightSelector(entry), 0.0001) ** exponent,
  }));
  const totalWeight = weightedEntries.reduce((sum, item) => sum + item.weight, 0);
  let cursor = rng() * totalWeight;
  for (const item of weightedEntries) {
    cursor -= item.weight;
    if (cursor <= 0) return item.entry;
  }
  return weightedEntries.at(-1)?.entry;
}

function drawRawWeightedPicks(ranked, config, candidate, rng) {
  const candidatePoolSize = Math.min(ranked.length, Math.max(config.pickCount * 5, 28));
  const remaining = ranked.slice(0, candidatePoolSize);
  const selected = [];

  while (selected.length < config.pickCount && remaining.length > 0) {
    const pick = weightedChoice(remaining, rng);
    const index = remaining.findIndex((entry) => entry.number === pick.number);
    selected.push(pick);
    remaining.splice(index, 1);
  }

  while (selected.filter((entry) => !entry.isBirthdayNumber).length < candidate.minimumNonBirthdayNumbers) {
    const selectedNumbers = new Set(selected.map((entry) => entry.number));
    const replacementPool = ranked
      .filter((entry) => !entry.isBirthdayNumber && !selectedNumbers.has(entry.number))
      .slice(0, candidatePoolSize);
    const birthdayToReplace = [...selected]
      .filter((entry) => entry.isBirthdayNumber)
      .sort((left, right) => left.score - right.score)[0];
    const replacement = weightedChoice(replacementPool, rng);

    if (!replacement || !birthdayToReplace) break;

    const replaceIndex = selected.findIndex((entry) => entry.number === birthdayToReplace.number);
    selected[replaceIndex] = replacement;
  }

  return selected
    .map((entry) => entry.number)
    .sort((left, right) => left - right);
}

function selectHeuristicPatternPicks(ranked, config, candidate, patternProfile, rng) {
  const rankedLookup = createRankLookup(ranked);
  const candidates = [];
  const seen = new Set();
  const topNumbers = ranked
    .slice(0, config.pickCount)
    .map((entry) => entry.number)
    .sort((left, right) => left - right);
  const topKey = topNumbers.join("-");
  seen.add(topKey);
  candidates.push(scoreCandidate(topNumbers, rankedLookup, patternProfile, config, candidate));

  for (let attempt = 0; attempt < samplesPerDraw; attempt += 1) {
    const numbers = drawRawWeightedPicks(ranked, config, candidate, rng);
    const key = numbers.join("-");
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(scoreCandidate(numbers, rankedLookup, patternProfile, config, candidate));
  }

  return candidates.sort((left, right) => {
    if (right.combinedScore !== left.combinedScore) return right.combinedScore - left.combinedScore;
    if (right.numberScore !== left.numberScore) return right.numberScore - left.numberScore;
    return left.numbers.join("-").localeCompare(right.numbers.join("-"));
  })[0].numbers;
}

function countHits(predictedNumbers, actualNumbers) {
  const actualSet = new Set(actualNumbers);
  return predictedNumbers.filter((number) => actualSet.has(number)).length;
}

function choose(n, r) {
  if (r < 0 || r > n) return 0;
  const k = Math.min(r, n - r);
  let result = 1;
  for (let index = 1; index <= k; index += 1) {
    result *= (n - k + index) / index;
  }
  return result;
}

function hypergeometricProbability(poolSize, drawnCount, pickedCount, hits) {
  return (
    (choose(drawnCount, hits) * choose(poolSize - drawnCount, pickedCount - hits)) /
    choose(poolSize, pickedCount)
  );
}

function randomExpected(rows, config) {
  const expected = {
    totalHits: 0,
    atLeast2: 0,
    atLeast3: 0,
    atLeast4: 0,
  };

  for (const row of rows) {
    const poolSize = config.poolSizeForDate(row.draw_date);
    for (let hits = 0; hits <= config.pickCount; hits += 1) {
      const probability = hypergeometricProbability(poolSize, config.pickCount, config.pickCount, hits);
      expected.totalHits += probability * hits;
      if (hits >= 2) expected.atLeast2 += probability;
      if (hits >= 3) expected.atLeast3 += probability;
      if (hits >= 4) expected.atLeast4 += probability;
    }
  }

  return expected;
}

function phaseForDate(drawDate, latestDate) {
  const testEnd = testEndArg || latestDate;
  if (drawDate >= testStart && drawDate <= testEnd) return "test";
  if (drawDate >= validationStart && drawDate < testStart) return "validation";
  return "training";
}

function emptyMetrics(candidate, phase) {
  return {
    candidate_id: candidate.id,
    phase,
    draws: 0,
    total_hits: 0,
    avg_hits_per_draw: 0,
    at_least_2: 0,
    at_least_3: 0,
    at_least_4: 0,
    rate_at_least_2: 0,
    rate_at_least_3: 0,
    rate_at_least_4: 0,
    objective_score: 0,
  };
}

function summarizeHits(candidate, phase, hitsRows, testRows, config) {
  if (hitsRows.length === 0) return emptyMetrics(candidate, phase);

  const totalHits = hitsRows.reduce((sum, row) => sum + row.hits, 0);
  const atLeast2 = hitsRows.filter((row) => row.hits >= 2).length;
  const atLeast3 = hitsRows.filter((row) => row.hits >= 3).length;
  const atLeast4 = hitsRows.filter((row) => row.hits >= 4).length;
  const random = randomExpected(testRows, config);
  const avgHits = totalHits / hitsRows.length;
  const rate2 = atLeast2 / hitsRows.length;
  const rate3 = atLeast3 / hitsRows.length;
  const rate4 = atLeast4 / hitsRows.length;
  const objective = avgHits + 0.65 * rate2 + 2.5 * rate3 + 8 * rate4;

  return {
    candidate_id: candidate.id,
    phase,
    draws: hitsRows.length,
    total_hits: totalHits,
    avg_hits_per_draw: Number(round(avgHits)),
    at_least_2: atLeast2,
    at_least_3: atLeast3,
    at_least_4: atLeast4,
    rate_at_least_2: Number(round(rate2)),
    rate_at_least_3: Number(round(rate3)),
    rate_at_least_4: Number(round(rate4)),
    random_expected_avg_hits: Number(round(random.totalHits / hitsRows.length)),
    lift_avg_hits_vs_random: Number(round(avgHits / (random.totalHits / hitsRows.length))),
    lift_at_least_2_vs_random: Number(round(atLeast2 / Math.max(0.000001, random.atLeast2))),
    lift_at_least_3_vs_random: Number(round(atLeast3 / Math.max(0.000001, random.atLeast3))),
    lift_at_least_4_vs_random: Number(round(atLeast4 / Math.max(0.000001, random.atLeast4))),
    objective_score: Number(round(objective)),
  };
}

function evaluateCandidate(rows, config, candidate, phase) {
  const latestDate = rows.at(-1)?.draw_date ?? "";
  const hitsRows = [];
  const phaseRows = [];

  for (let index = warmupDraws; index < rows.length; index += 1) {
    const target = rows[index];
    if (phaseForDate(target.draw_date, latestDate) !== phase) continue;

    const trainingRows = rows.slice(0, index);
    const poolSize = config.poolSizeForDate(target.draw_date);
    const rng = createRng(hashString(`${seed}:${config.key}:${candidate.id}:${phase}:${index}`));
    const ranked = scoreCompositeWeighted(trainingRows, config, candidate, poolSize);
    const patternProfile = createPatternProfile(trainingRows, config, poolSize);
    const predicted = selectHeuristicPatternPicks(ranked, config, candidate, patternProfile, rng);
    const actual = getMainNumbers(target, config);
    const hits = countHits(predicted, actual);

    hitsRows.push({ hits });
    phaseRows.push(target);
  }

  return summarizeHits(candidate, phase, hitsRows, phaseRows, config);
}

function normalizeWeights(recentActivity, longTermHotness, coldRebound) {
  const total = recentActivity + longTermHotness + coldRebound;
  return {
    recentActivity: recentActivity / total,
    longTermHotness: longTermHotness / total,
    coldRebound: coldRebound / total,
  };
}

function makeCandidate(id, config, values) {
  return {
    id,
    halfLife: values.halfLife,
    minimumNonBirthdayNumbers: values.minimumNonBirthdayNumbers,
    scoreWeights: values.scoreWeights,
    combinationScoreWeights: values.combinationScoreWeights,
  };
}

function generateCandidates(config) {
  const rng = createRng(seed + hashString(config.key));
  const candidates = [
    makeCandidate("baseline_current", config, {
      halfLife: config.defaultHalfLife,
      minimumNonBirthdayNumbers: config.defaultMinimumNonBirthdayNumbers,
      scoreWeights: normalizeWeights(0.46, 0.34, 0.2),
      combinationScoreWeights: defaultCombinationScoreWeights,
    }),
  ];

  for (let index = 0; index < trials; index += 1) {
    const halfLife = halfLifeCandidates[Math.floor(rng() * halfLifeCandidates.length)];
    const recent = 0.15 + rng() * 0.65;
    const hot = 0.10 + rng() * 0.55;
    const cold = 0.05 + rng() * 0.35;
    const patternProfile = 0.12 + rng() * 0.42;
    const minimumNonBirthdayNumbers = rng() < 0.72 ? 2 : 3;
    candidates.push(
      makeCandidate(`trial_${String(index + 1).padStart(4, "0")}`, config, {
        halfLife,
        minimumNonBirthdayNumbers,
        scoreWeights: normalizeWeights(recent, hot, cold),
        combinationScoreWeights: {
          numberScore: 1 - patternProfile,
          patternProfile,
        },
      }),
    );
  }

  return candidates;
}

async function loadRows(config) {
  const csv = await findLatestCsv(config.key);
  const rows = parseCsv(await fs.readFile(csv.fullPath, "utf8")).sort((left, right) => {
    const dateCompare = left.draw_date.localeCompare(right.draw_date);
    if (dateCompare !== 0) return dateCompare;
    return Number(left.draw_number) - Number(right.draw_number);
  });
  return { csv, rows };
}

async function trainGame(config) {
  const { csv, rows } = await loadRows(config);
  const candidates = generateCandidates(config);
  const validationResults = [];

  for (const candidate of candidates) {
    const validation = evaluateCandidate(rows, config, candidate, "validation");
    validationResults.push({ candidate, validation });
  }

  validationResults.sort((left, right) => {
    if (right.validation.objective_score !== left.validation.objective_score) {
      return right.validation.objective_score - left.validation.objective_score;
    }
    return right.validation.lift_avg_hits_vs_random - left.validation.lift_avg_hits_vs_random;
  });

  const best = validationResults[0];
  const test = evaluateCandidate(rows, config, best.candidate, "test");
  const topCandidates = validationResults.slice(0, 12).map(({ candidate, validation }, rank) => ({
    rank: rank + 1,
    candidate_id: candidate.id,
    half_life_draws: candidate.halfLife,
    minimum_non_birthday_numbers: candidate.minimumNonBirthdayNumbers,
    recent_activity: Number(round(candidate.scoreWeights.recentActivity)),
    long_term_hotness: Number(round(candidate.scoreWeights.longTermHotness)),
    cold_rebound: Number(round(candidate.scoreWeights.coldRebound)),
    number_score: Number(round(candidate.combinationScoreWeights.numberScore)),
    pattern_profile: Number(round(candidate.combinationScoreWeights.patternProfile)),
    validation_objective_score: validation.objective_score,
    validation_avg_hits_per_draw: validation.avg_hits_per_draw,
    validation_lift_avg_hits_vs_random: validation.lift_avg_hits_vs_random,
    validation_lift_at_least_3_vs_random: validation.lift_at_least_3_vs_random,
  }));

  return {
    csvPath: csv.fullPath,
    rows: rows.length,
    firstDrawDate: rows[0]?.draw_date ?? "",
    lastDrawDate: rows.at(-1)?.draw_date ?? "",
    bestCandidate: best.candidate,
    validation: best.validation,
    test,
    topCandidates,
  };
}

await fs.mkdir(outputDir, { recursive: true });

const generatedAt = new Date().toISOString();
const results = {};
const candidateCsvRows = [];

for (const config of gameConfigs) {
  const result = await trainGame(config);
  results[config.key] = result;
  for (const candidate of result.topCandidates) {
    candidateCsvRows.push({
      game: config.label,
      ...candidate,
    });
  }
}

const trainedConfig = {
  generatedAt,
  model: "composite_weighted_v3_pattern_profile_trained",
  trainingMethod: "random_weight_search_holdout",
  objective: "avg_hits + 0.65*rate>=2 + 2.5*rate>=3 + 8*rate>=4 on validation split",
  splits: {
    validationStart,
    testStart,
    testEnd: testEndArg || "latest_draw_date",
    warmupDraws,
  },
  search: {
    seed,
    trials,
    samplesPerDraw,
    halfLifeCandidates,
  },
  games: Object.fromEntries(
    gameConfigs.map((config) => {
      const result = results[config.key];
      const candidate = result.bestCandidate;
      return [
        config.key,
        {
          label: config.label,
          sourceCsvPath: result.csvPath,
          sourceRows: result.rows,
          sourceFirstDrawDate: result.firstDrawDate,
          sourceLastDrawDate: result.lastDrawDate,
          halfLife: candidate.halfLife,
          minimumNonBirthdayNumbers: candidate.minimumNonBirthdayNumbers,
          scoreWeights: candidate.scoreWeights,
          combinationScoreWeights: candidate.combinationScoreWeights,
          validation: result.validation,
          test: result.test,
          topCandidates: result.topCandidates,
        },
      ];
    }),
  ),
};

const summaryPath = path.join(outputDir, "training_summary.json");
const candidatesPath = path.join(outputDir, "training_top_candidates.csv");
await fs.writeFile(summaryPath, JSON.stringify(trainedConfig, null, 2), "utf8");
await fs.writeFile(
  candidatesPath,
  rowsToCsv(candidateCsvRows, [
    "game",
    "rank",
    "candidate_id",
    "half_life_draws",
    "minimum_non_birthday_numbers",
    "recent_activity",
    "long_term_hotness",
    "cold_rebound",
    "number_score",
    "pattern_profile",
    "validation_objective_score",
    "validation_avg_hits_per_draw",
    "validation_lift_avg_hits_vs_random",
    "validation_lift_at_least_3_vs_random",
  ]),
  "utf8",
);

if (writeConfig) {
  await fs.writeFile(configOutputPath, JSON.stringify(trainedConfig, null, 2), "utf8");
}

console.log(
  JSON.stringify(
    {
      generatedAt,
      summaryPath,
      candidatesPath,
      configOutputPath: writeConfig ? configOutputPath : null,
      games: Object.fromEntries(
        gameConfigs.map((config) => {
          const result = results[config.key];
          return [
            config.key,
            {
              label: config.label,
              bestHalfLife: result.bestCandidate.halfLife,
              bestScoreWeights: result.bestCandidate.scoreWeights,
              bestCombinationScoreWeights: result.bestCandidate.combinationScoreWeights,
              validation: result.validation,
              test: result.test,
            },
          ];
        }),
      ),
    },
    null,
    2,
  ),
);
