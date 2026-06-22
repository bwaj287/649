import fs from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.split("=");
    return [key.replace(/^--/, ""), value ?? "true"];
  }),
);

const yearsBack = Number(args.yearsBack ?? 10);
const endDate = args.endDate ? new Date(`${args.endDate}T12:00:00`) : new Date();
const outputDir = args.outputDir ?? "F:\\649";
const concurrency = Number(args.concurrency ?? 4);
const requestDelayMs = Number(args.requestDelayMs ?? 120);

const LOTTO_649_DRAW_DAYS = new Set([3, 6]);
const LOTTO_MAX_FRIDAY_ONLY_END = new Date("2019-05-10T12:00:00");
const LOTTO_MAX_TUESDAY_START = new Date("2019-05-14T12:00:00");
const LOTTO_MAX_DRAW_DAYS = new Set([2, 5]);

if (Number.isNaN(yearsBack) || yearsBack <= 0) {
  throw new Error("yearsBack must be a positive number");
}

if (Number.isNaN(endDate.getTime())) {
  throw new Error("endDate must be a valid YYYY-MM-DD value");
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isSameCalendarDate(left, right) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function cloneDate(date) {
  return new Date(date.getTime());
}

function addDays(date, days) {
  const next = cloneDate(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addYears(date, years) {
  const next = cloneDate(date);
  next.setFullYear(next.getFullYear() + years);
  return next;
}

function getScheduledDates(startDate, finalDate, validDays) {
  const dates = [];
  let cursor = cloneDate(startDate);
  cursor.setHours(12, 0, 0, 0);

  const end = cloneDate(finalDate);
  end.setHours(12, 0, 0, 0);

  while (cursor <= end) {
    if (validDays.has(cursor.getDay())) {
      dates.push(cloneDate(cursor));
    }

    cursor = addDays(cursor, 1);
  }

  return dates;
}

function getLottoMaxScheduledDates(startDate, finalDate) {
  const fridayOnlyStart = cloneDate(startDate);
  const fridayOnlyEnd = new Date(Math.min(finalDate.getTime(), LOTTO_MAX_FRIDAY_ONLY_END.getTime()));
  const tuesdayFridayStart = new Date(Math.max(startDate.getTime(), LOTTO_MAX_TUESDAY_START.getTime()));
  const tuesdayFridayEnd = cloneDate(finalDate);

  const fridayOnlyDates =
    fridayOnlyStart <= fridayOnlyEnd ? getScheduledDates(fridayOnlyStart, fridayOnlyEnd, new Set([5])) : [];
  const tuesdayFridayDates =
    tuesdayFridayStart <= tuesdayFridayEnd ? getScheduledDates(tuesdayFridayStart, tuesdayFridayEnd, LOTTO_MAX_DRAW_DAYS) : [];

  return [...fridayOnlyDates, ...tuesdayFridayDates];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url, maxAttempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (requestDelayMs > 0) {
        await sleep(requestDelayMs);
      }

      const response = await fetch(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
          accept: "application/json, text/plain, */*",
          referer: "https://www.playnow.com/",
          origin: "https://www.playnow.com",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(1000 * attempt);
      }
    }
  }

  throw lastError;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }

      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function parseDrawDate(drawDateText, fallbackDate) {
  const parsed = new Date(`${drawDateText} 12:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return formatDate(fallbackDate);
  }

  return formatDate(parsed);
}

function joinList(values, separator = " ") {
  if (!Array.isArray(values)) {
    return "";
  }

  return values.join(separator);
}

function convertGuaranteedPrizeNumber(entry) {
  if (!entry || !Array.isArray(entry.drawNbrs)) {
    return "";
  }

  const digits = entry.drawNbrs.map(String);
  if (digits.length < 10) {
    return digits.join("");
  }

  return `${digits.slice(0, 7).join("")}-${digits.slice(7).join("")}`;
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
  return lines.join("\r\n");
}

async function fetchLotto649History(startDate, finalDate) {
  const dates = getScheduledDates(startDate, finalDate, LOTTO_649_DRAW_DAYS);
  return mapWithConcurrency(dates, concurrency, async (date) => {
    const requestDate = formatDate(date);
    const sourceUrl = `https://www.playnow.com/services2/lotto/draw/six49/${requestDate}`;
    const data = await fetchJsonWithRetry(sourceUrl);
    const goldBallRows = Array.isArray(data.gpNumbers) ? data.gpNumbers : [];
    const parsedDrawDate = parseDrawDate(data.drawDate, date);
    const drawDateValue = new Date(`${parsedDrawDate}T12:00:00`);

    return {
      game: "Lotto 649",
      source: "PlayNow BCLC official",
      source_url: sourceUrl,
      request_date: requestDate,
      draw_date: parsedDrawDate,
      draw_day: drawDateValue.toLocaleDateString("en-US", { weekday: "long" }),
      draw_number: data.drawNbr,
      main_1: data.drawNbrs?.[0] ?? "",
      main_2: data.drawNbrs?.[1] ?? "",
      main_3: data.drawNbrs?.[2] ?? "",
      main_4: data.drawNbrs?.[3] ?? "",
      main_5: data.drawNbrs?.[4] ?? "",
      main_6: data.drawNbrs?.[5] ?? "",
      bonus_number: data.bonusNbr ?? "",
      extra_1: data.extraNbrs?.[0] ?? "",
      extra_2: data.extraNbrs?.[1] ?? "",
      extra_3: data.extraNbrs?.[2] ?? "",
      extra_4: data.extraNbrs?.[3] ?? "",
      draw_version: data.drawVersion ?? "",
      gold_ball_draw_count: goldBallRows.length,
      gold_ball_numbers: goldBallRows.map(convertGuaranteedPrizeNumber).join(";"),
      gold_ball_drawn: goldBallRows.some((row) => row?.goldBallDrawn === true),
      gold_ball_prize_amounts: goldBallRows.map((row) => row?.goldBallPrizeAmount ?? "").join(";"),
      white_ball_prize_amounts: goldBallRows.map((row) => row?.whiteBallPrizeAmount ?? "").join(";"),
      gold_ball_prize_descriptions: goldBallRows.map((row) => row?.prizeDesc ?? "").join(";"),
      additional_prize_numbers: Array.isArray(data.gpAdditionalNumbers)
        ? data.gpAdditionalNumbers.map((row) => joinList(row, "-")).join(";")
        : "",
    };
  });
}

async function fetchLottoMaxHistory(startDate, finalDate) {
  const dates = getLottoMaxScheduledDates(startDate, finalDate);
  return mapWithConcurrency(dates, concurrency, async (date) => {
    const requestDate = formatDate(date);
    const sourceUrl = `https://www.playnow.com/services2/lotto/draw/lmax/${requestDate}`;
    const data = await fetchJsonWithRetry(sourceUrl);
    const bonusDraws = Array.isArray(data.bonusDraws) ? data.bonusDraws : [];
    const maxPlusRows = Array.isArray(data.gameBreakdown)
      ? data.gameBreakdown.filter((row) => row?.prizeDiv === 16)
      : [];
    const maxPlusAmounts = [...new Set(maxPlusRows.map((row) => row?.prizeAmount).filter((value) => value !== undefined && value !== null))];
    const parsedDrawDate = parseDrawDate(data.drawDate, date);
    const drawDateValue = new Date(`${parsedDrawDate}T12:00:00`);

    return {
      game: "Lotto Max",
      source: "PlayNow BCLC official",
      source_url: sourceUrl,
      request_date: requestDate,
      draw_date: parsedDrawDate,
      draw_day: drawDateValue.toLocaleDateString("en-US", { weekday: "long" }),
      draw_number: data.drawNbr,
      main_1: data.drawNbrs?.[0] ?? "",
      main_2: data.drawNbrs?.[1] ?? "",
      main_3: data.drawNbrs?.[2] ?? "",
      main_4: data.drawNbrs?.[3] ?? "",
      main_5: data.drawNbrs?.[4] ?? "",
      main_6: data.drawNbrs?.[5] ?? "",
      main_7: data.drawNbrs?.[6] ?? "",
      bonus_number: data.bonusNbr ?? "",
      extra_1: data.extraNbrs?.[0] ?? "",
      extra_2: data.extraNbrs?.[1] ?? "",
      extra_3: data.extraNbrs?.[2] ?? "",
      extra_4: data.extraNbrs?.[3] ?? "",
      draw_version: data.drawVersion ?? "",
      bonus_draw_count: bonusDraws.length,
      bonus_draw_numbers: bonusDraws.map((row) => joinList(row, "-")).join(";"),
      max_million_pending: data.maxMillionPending ?? "",
      max_plus_count: maxPlusRows.length,
      max_plus_amounts: maxPlusAmounts.join(";"),
    };
  });
}

const startDate = addYears(endDate, -yearsBack);
startDate.setHours(12, 0, 0, 0);
endDate.setHours(12, 0, 0, 0);

const today = new Date();
today.setHours(12, 0, 0, 0);
const effectiveEndDate = isSameCalendarDate(endDate, today) ? addDays(endDate, -1) : cloneDate(endDate);

await fs.mkdir(outputDir, { recursive: true });

const [lotto649RowsRaw, lottoMaxRowsRaw] = await Promise.all([
  fetchLotto649History(startDate, effectiveEndDate),
  fetchLottoMaxHistory(startDate, effectiveEndDate),
]);

const lotto649Rows = lotto649RowsRaw.filter(Boolean);
const lottoMaxRows = lottoMaxRowsRaw.filter(Boolean);

lotto649Rows.sort((a, b) => a.draw_date.localeCompare(b.draw_date));
lottoMaxRows.sort((a, b) => a.draw_date.localeCompare(b.draw_date));

const rangeLabel = `${formatDate(startDate)}_to_${formatDate(effectiveEndDate)}`;
const lotto649Path = path.join(outputDir, `lotto649_${rangeLabel}.csv`);
const lottoMaxPath = path.join(outputDir, `lottomax_${rangeLabel}.csv`);

const lotto649Columns = [
  "game",
  "source",
  "source_url",
  "request_date",
  "draw_date",
  "draw_day",
  "draw_number",
  "main_1",
  "main_2",
  "main_3",
  "main_4",
  "main_5",
  "main_6",
  "bonus_number",
  "extra_1",
  "extra_2",
  "extra_3",
  "extra_4",
  "draw_version",
  "gold_ball_draw_count",
  "gold_ball_numbers",
  "gold_ball_drawn",
  "gold_ball_prize_amounts",
  "white_ball_prize_amounts",
  "gold_ball_prize_descriptions",
  "additional_prize_numbers",
];

const lottoMaxColumns = [
  "game",
  "source",
  "source_url",
  "request_date",
  "draw_date",
  "draw_day",
  "draw_number",
  "main_1",
  "main_2",
  "main_3",
  "main_4",
  "main_5",
  "main_6",
  "main_7",
  "bonus_number",
  "extra_1",
  "extra_2",
  "extra_3",
  "extra_4",
  "draw_version",
  "bonus_draw_count",
  "bonus_draw_numbers",
  "max_million_pending",
  "max_plus_count",
  "max_plus_amounts",
];

await fs.writeFile(lotto649Path, rowsToCsv(lotto649Rows, lotto649Columns), "utf8");
await fs.writeFile(lottoMaxPath, rowsToCsv(lottoMaxRows, lottoMaxColumns), "utf8");

console.log(
  JSON.stringify(
    {
      outputDir,
      startDate: formatDate(startDate),
      requestedEndDate: formatDate(endDate),
      effectiveEndDate: formatDate(effectiveEndDate),
      requestDelayMs,
      lotto649Rows: lotto649Rows.length,
      lotto649Csv: lotto649Path,
      lottoMaxRows: lottoMaxRows.length,
      lottoMaxCsv: lottoMaxPath,
      concurrency,
    },
    null,
    2,
  ),
);
