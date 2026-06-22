import { spawn } from "node:child_process";
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
const lotto649HalfLife = Number(args.lotto649HalfLife ?? 26);
const lottoMaxHalfLife = Number(args.lottoMaxHalfLife ?? 208);

const gameConfigs = [
  {
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
    drawDays: new Set([3, 6]),
    mainColumns: ["main_1", "main_2", "main_3", "main_4", "main_5", "main_6"],
    poolSizeForDate() {
      return 49;
    },
  },
  {
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
    candidates.push({ fullPath, mtimeMs: stat.mtimeMs, name: file.name });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
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

function predictionForGame(rows, config) {
  const latestRow = rows.at(-1);
  const predictionDate = nextDrawDate(config.key, latestRow.draw_date);
  const poolSize = config.poolSizeForDate(predictionDate);
  const ranked = scoreCompositeWeighted(rows, config, poolSize);
  const picks = selectPrizeSharingAwarePicks(ranked, config);
  const nonBirthdayCount = picks.filter((number) => number > 31).length;

  return {
    game: config.label,
    prediction_for_next_draw_after: latestRow.draw_date,
    estimated_next_draw_date: predictionDate,
    latest_draw_number: latestRow.draw_number,
    model: "composite_weighted_v2",
    half_life_draws: config.halfLife,
    model_weights: `recent_activity=${config.scoreWeights.recentActivity};long_term_hotness=${config.scoreWeights.longTermHotness};cold_rebound=${config.scoreWeights.coldRebound}`,
    birthday_sharing_rule: `minimum_${config.minimumNonBirthdayNumbers}_numbers_above_31`,
    non_birthday_count: nonBirthdayCount,
    pool_size: poolSize,
    picks: picks.join("-"),
    top_12_weighted_numbers: ranked
      .slice(0, 12)
      .map(
        (entry) =>
          `${entry.number}:${entry.score.toFixed(4)}(R${entry.recentActivityScore.toFixed(2)},H${entry.longTermHotnessScore.toFixed(2)},C${entry.coldReboundScore.toFixed(2)})`,
      )
      .join(";"),
  };
}

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

for (const config of gameConfigs) {
  const csvPath = csvPaths[config.key];
  const rows = parseCsv(await fs.readFile(csvPath, "utf8")).sort((left, right) => {
    const dateCompare = left.draw_date.localeCompare(right.draw_date);
    if (dateCompare !== 0) return dateCompare;
    return Number(left.draw_number) - Number(right.draw_number);
  });

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
  predictionRows.push(predictionForGame(rows, config));
}

const predictionColumns = [
  "game",
  "prediction_for_next_draw_after",
  "estimated_next_draw_date",
  "latest_draw_number",
  "model",
  "half_life_draws",
  "model_weights",
  "birthday_sharing_rule",
  "non_birthday_count",
  "pool_size",
  "picks",
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
      refreshedAt: new Date().toISOString(),
      refresh,
      updateSummary,
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
  predictionRows.map((row) => `${row.game}: ${row.picks}`).join("\r\n") + "\r\n",
  "utf8",
);

console.log(
  JSON.stringify(
    {
      outputDir,
      refreshedCsvs: csvPaths,
      updateSummary,
      validationReports,
      predictions: predictionRows.map((row) => ({
        game: row.game,
        nextDrawDate: row.estimated_next_draw_date,
        halfLifeDraws: row.half_life_draws,
        picks: row.picks,
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
