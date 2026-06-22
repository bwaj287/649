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
const concurrency = Number(args.concurrency ?? 6);
const requestDelayMs = Number(args.requestDelayMs ?? 40);
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

function countScheduledDraws(gameKey, startDate, finalDate) {
  if (startDate > finalDate) {
    return 0;
  }

  if (gameKey === "lotto649") {
    return getScheduledDates(startDate, finalDate, LOTTO_649_DRAW_DAYS).length;
  }

  if (gameKey === "lottomax") {
    return getLottoMaxScheduledDates(startDate, finalDate).length;
  }

  throw new Error(`Unsupported game key for schedule count: ${gameKey}`);
}

function getScheduledDateKeys(gameKey, startDate, finalDate) {
  if (startDate > finalDate) {
    return [];
  }

  const dates =
    gameKey === "lotto649"
      ? getScheduledDates(startDate, finalDate, LOTTO_649_DRAW_DAYS)
      : getLottoMaxScheduledDates(startDate, finalDate);

  return dates.map((date) => formatDate(date));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function htmlDecode(text) {
  return String(text)
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function cleanText(text) {
  return htmlDecode(text).replace(/\s+/g, " ").trim();
}

function parseDateText(dateText) {
  const monthIndex = {
    January: 0,
    February: 1,
    March: 2,
    April: 3,
    May: 4,
    June: 5,
    July: 6,
    August: 7,
    September: 8,
    October: 9,
    November: 10,
    December: 11,
  };

  const match = cleanText(dateText).match(/^[A-Za-z]+,\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
  if (!match) {
    throw new Error(`Unable to parse draw date text: ${dateText}`);
  }

  const [, monthName, dayText, yearText] = match;
  const month = monthIndex[monthName];
  if (month === undefined) {
    throw new Error(`Unknown month in draw date text: ${dateText}`);
  }

  const date = new Date(Number(yearText), month, Number(dayText), 12, 0, 0, 0);
  return {
    value: date,
    key: formatDate(date),
  };
}

function normalizeMoney(text) {
  const match = cleanText(text).match(/\$([\d,]+\.\d{2})/);
  if (!match) {
    return "";
  }

  return match[1].replace(/,/g, "");
}

function getFirstMatch(text, regex, description) {
  const match = text.match(regex);
  if (!match) {
    throw new Error(`Unable to find ${description}`);
  }

  return match;
}

function extractMainDraw(html, expectedCount) {
  const match = getFirstMatch(
    html,
    /<div class="pastWinNumGroup">[\s\S]*?<h3>\s*([^<]+?)\s*<\/h3>[\s\S]*?<ul class="pastWinNumbers">([\s\S]*?)<\/ul>/,
    "main draw numbers",
  );

  const label = cleanText(match[1]);
  const listHtml = match[2];
  const mainNumbers = [...listHtml.matchAll(/<li class="pastWinNumber">(\d+)<\/li>/g)].map((entry) => Number(entry[1]));
  const bonusMatch = getFirstMatch(listHtml, /<li class="pastWinNumberBonus">[\s\S]*?(\d+)\s*<\/li>/, "bonus number");
  const bonusNumber = Number(bonusMatch[1]);

  if (mainNumbers.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} main numbers but found ${mainNumbers.length}`);
  }

  return {
    label,
    mainNumbers,
    bonusNumber,
  };
}

function extractExtraNumber(html) {
  const match = html.match(/<div class="pastWinNumExtra">\s*(\d+)\s*<\/div>/);
  return match ? match[1] : "";
}

function extract649SecondaryData(html) {
  const secondaryNumbers = [...new Set((html.match(/\b\d{8}-\d{2}\b/g) ?? []).map((value) => cleanText(value)))];
  const ballMatch = html.match(/Ball Drawn:<\/b><\/div>\s*<div class="pastWinNumLogoGPD">([^<]+)<\/div>/);
  const ballResult = ballMatch ? cleanText(ballMatch[1]) : "";

  return {
    secondaryNumbers: secondaryNumbers.join(";"),
    secondaryBallResult: ballResult,
  };
}

function extractLottoMaxAdditionalNumbers(html, sectionClass) {
  const pattern = new RegExp(`<div class="${sectionClass}">([\\s\\S]*?)<\\/div>\\s*<\\/td>`, "g");
  const values = [];

  for (const match of html.matchAll(pattern)) {
    const numbers = [...match[1].matchAll(/prizeBreadkownLottoMaximillionsNum">(\d+)<\/div>/g)].map((entry) => entry[1]);
    if (numbers.length > 0) {
      values.push(numbers.join("-"));
    }
  }

  return values;
}

function convertGuaranteedPrizeNumber(entry) {
  if (!entry || !Array.isArray(entry.drawNbrs)) {
    return "";
  }

  const digits = entry.drawNbrs.map(String);
  if (digits.length < 10) {
    return digits.join("");
  }

  return `${digits.slice(0, 8).join("")}-${digits.slice(8).join("")}`;
}

function parsePlayNowDrawDate(drawDateText, fallbackDateKey) {
  const parsed = new Date(`${drawDateText} 12:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    const fallback = new Date(`${fallbackDateKey}T12:00:00`);
    return {
      value: fallback,
      key: fallbackDateKey,
    };
  }

  return {
    value: parsed,
    key: formatDate(parsed),
  };
}

function parsePlayNow649(data, sourceUrl, requestDateKey) {
  const parsedDate = parsePlayNowDrawDate(data.drawDate, requestDateKey);
  const goldBallRows = Array.isArray(data.gpNumbers) ? data.gpNumbers : [];
  const anyGoldBall = goldBallRows.some((row) => row?.goldBallDrawn === true);
  const anyWhiteBall = goldBallRows.some((row) => row?.goldBallDrawn === false);

  return {
    game: "Lotto 649",
    source: "PlayNow BCLC official (fallback)",
    source_url: sourceUrl,
    draw_number: data.drawNbr ?? "",
    draw_date: parsedDate.key,
    draw_date_value: parsedDate.value,
    draw_day: parsedDate.value.toLocaleDateString("en-US", { weekday: "long" }),
    main_draw_label: "MAIN DRAW",
    jackpot_amount: "",
    main_1: data.drawNbrs?.[0] ?? "",
    main_2: data.drawNbrs?.[1] ?? "",
    main_3: data.drawNbrs?.[2] ?? "",
    main_4: data.drawNbrs?.[3] ?? "",
    main_5: data.drawNbrs?.[4] ?? "",
    main_6: data.drawNbrs?.[5] ?? "",
    bonus_number: data.bonusNbr ?? "",
    extra_number: "",
    secondary_numbers: goldBallRows.map(convertGuaranteedPrizeNumber).filter(Boolean).join(";"),
    secondary_ball_result: anyGoldBall ? "Gold" : anyWhiteBall ? "White" : "",
  };
}

function parsePlayNowMax(data, sourceUrl, requestDateKey) {
  const parsedDate = parsePlayNowDrawDate(data.drawDate, requestDateKey);
  const bonusDraws = Array.isArray(data.bonusDraws) ? data.bonusDraws : [];

  return {
    game: "Lotto Max",
    source: "PlayNow BCLC official (fallback)",
    source_url: sourceUrl,
    draw_number: data.drawNbr ?? "",
    draw_date: parsedDate.key,
    draw_date_value: parsedDate.value,
    draw_day: parsedDate.value.toLocaleDateString("en-US", { weekday: "long" }),
    jackpot_amount: "",
    main_1: data.drawNbrs?.[0] ?? "",
    main_2: data.drawNbrs?.[1] ?? "",
    main_3: data.drawNbrs?.[2] ?? "",
    main_4: data.drawNbrs?.[3] ?? "",
    main_5: data.drawNbrs?.[4] ?? "",
    main_6: data.drawNbrs?.[5] ?? "",
    main_7: data.drawNbrs?.[6] ?? "",
    bonus_number: data.bonusNbr ?? "",
    extra_number: "",
    maxmillions_count: bonusDraws.length,
    maxmillions_numbers: bonusDraws.map((row) => (Array.isArray(row) ? row.join("-") : "")).filter(Boolean).join(";"),
    maxplus_count: 0,
    maxplus_numbers: "",
  };
}

function parseLotto649Page(html, sourceUrl, drawNumber) {
  const dateMatch = getFirstMatch(
    html,
    /<div class="pastWinNumDate[^"]*">[\s\S]*?<h4>\s*([^<]+?)\s*<\/h4>/,
    "Lotto 649 draw date",
  );
  const parsedDate = parseDateText(dateMatch[1]);
  const mainDraw = extractMainDraw(html, 6);
  const jackpotMatch = html.match(/Jackpot:\s*\$[\d,]+\.\d{2}/);
  const secondary = extract649SecondaryData(html);

  return {
    game: "Lotto 649",
    source: "WCLC official",
    source_url: sourceUrl,
    draw_number: drawNumber,
    draw_date: parsedDate.key,
    draw_date_value: parsedDate.value,
    draw_day: parsedDate.value.toLocaleDateString("en-US", { weekday: "long" }),
    main_draw_label: mainDraw.label,
    jackpot_amount: jackpotMatch ? normalizeMoney(jackpotMatch[0]) : "",
    main_1: mainDraw.mainNumbers[0],
    main_2: mainDraw.mainNumbers[1],
    main_3: mainDraw.mainNumbers[2],
    main_4: mainDraw.mainNumbers[3],
    main_5: mainDraw.mainNumbers[4],
    main_6: mainDraw.mainNumbers[5],
    bonus_number: mainDraw.bonusNumber,
    extra_number: extractExtraNumber(html),
    secondary_numbers: secondary.secondaryNumbers,
    secondary_ball_result: secondary.secondaryBallResult,
  };
}

function parseLottoMaxPage(html, sourceUrl, drawNumber) {
  const dateMatch = getFirstMatch(
    html,
    /<div class="pastWinNumDate[^"]*">[\s\S]*?<h4>\s*([^<]+?)\s*<\/h4>/,
    "Lotto Max draw date",
  );
  const parsedDate = parseDateText(dateMatch[1]);
  const mainDraw = extractMainDraw(html, 7);
  const jackpotMatch = html.match(/Jackpot:\s*\$[\d,]+\.\d{2}/);
  const maxMillionsNumbers = extractLottoMaxAdditionalNumbers(html, "prizeBreadkownLottoMaximillionsNumbers");
  const maxPlusNumbers = extractLottoMaxAdditionalNumbers(html, "prizeBreadkownLottoMaxplusNumbers");

  return {
    game: "Lotto Max",
    source: "WCLC official",
    source_url: sourceUrl,
    draw_number: drawNumber,
    draw_date: parsedDate.key,
    draw_date_value: parsedDate.value,
    draw_day: parsedDate.value.toLocaleDateString("en-US", { weekday: "long" }),
    jackpot_amount: jackpotMatch ? normalizeMoney(jackpotMatch[0]) : "",
    main_1: mainDraw.mainNumbers[0],
    main_2: mainDraw.mainNumbers[1],
    main_3: mainDraw.mainNumbers[2],
    main_4: mainDraw.mainNumbers[3],
    main_5: mainDraw.mainNumbers[4],
    main_6: mainDraw.mainNumbers[5],
    main_7: mainDraw.mainNumbers[6],
    bonus_number: mainDraw.bonusNumber,
    extra_number: extractExtraNumber(html),
    maxmillions_count: maxMillionsNumbers.length,
    maxmillions_numbers: maxMillionsNumbers.join(";"),
    maxplus_count: maxPlusNumbers.length,
    maxplus_numbers: maxPlusNumbers.join(";"),
  };
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

async function fetchTextWithRetry(url, maxAttempts = 4) {
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
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          referer: "https://www.wclc.com/",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(800 * attempt);
      }
    }
  }

  throw lastError;
}

const GAME_CONFIGS = {
  lotto649: {
    key: "lotto649",
    label: "Lotto 649",
    latestUrl: "https://www.wclc.com/winning-numbers/lotto-649-extra.htm",
    detailUrl(drawNumber) {
      return `https://www.wclc.com/lotto-649-prize-details.htm?drawNumber=${drawNumber}`;
    },
    playNowUrl(dateKey) {
      return `https://www.playnow.com/services2/lotto/draw/six49/${dateKey}`;
    },
    latestDrawPattern: /lotto-649-prize-details\.htm\?drawNumber=(\d+)/,
    parsePage: parseLotto649Page,
    parseFallback: parsePlayNow649,
  },
  lottomax: {
    key: "lottomax",
    label: "Lotto Max",
    latestUrl: "https://www.wclc.com/winning-numbers/lotto-max-extra.htm",
    detailUrl(drawNumber) {
      return `https://www.wclc.com/lotto-max-prize-details.htm?drawNumber=${drawNumber}`;
    },
    playNowUrl(dateKey) {
      return `https://www.playnow.com/services2/lotto/draw/lmax/${dateKey}`;
    },
    latestDrawPattern: /lotto-max-prize-details\.htm\?drawNumber=(\d+)/,
    parsePage: parseLottoMaxPage,
    parseFallback: parsePlayNowMax,
  },
};

const drawCache = new Map();
const unavailableDrawCache = new Set();

async function getLatestDrawNumber(game) {
  const html = await fetchTextWithRetry(game.latestUrl);
  const match = getFirstMatch(html, game.latestDrawPattern, `${game.label} latest draw number`);
  return Number(match[1]);
}

function isUnavailableWclcPage(html) {
  return /Prize information is not available for the date requested/i.test(html);
}

async function fetchDrawByNumberInternal(game, drawNumber, allowUnavailable) {
  const cacheKey = `${game.key}:${drawNumber}`;
  if (drawCache.has(cacheKey)) {
    return drawCache.get(cacheKey);
  }
  if (allowUnavailable && unavailableDrawCache.has(cacheKey)) {
    return null;
  }

  const sourceUrl = game.detailUrl(drawNumber);
  let lastError;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const html = await fetchTextWithRetry(sourceUrl);
      if (isUnavailableWclcPage(html)) {
        if (allowUnavailable) {
          unavailableDrawCache.add(cacheKey);
          return null;
        }
        throw new Error("WCLC page is unavailable for this draw number");
      }
      const row = game.parsePage(html, sourceUrl, drawNumber);
      drawCache.set(cacheKey, row);
      return row;
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await sleep(1000 * attempt);
      }
    }
  }

  throw new Error(`${game.label} draw ${drawNumber}: ${lastError.message}`);
}

async function fetchDrawByNumber(game, drawNumber) {
  return fetchDrawByNumberInternal(game, drawNumber, false);
}

async function fetchDrawByNumberOrNull(game, drawNumber) {
  return fetchDrawByNumberInternal(game, drawNumber, true);
}

async function fetchPlayNowFallback(game, dateKey) {
  const sourceUrl = game.playNowUrl(dateKey);
  let lastError;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      if (requestDelayMs > 0) {
        await sleep(requestDelayMs);
      }

      const response = await fetch(sourceUrl, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
          accept: "application/json, text/plain, */*",
          referer: "https://www.playnow.com/",
          origin: "https://www.playnow.com",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${sourceUrl}`);
      }

      const data = await response.json();
      return game.parseFallback(data, sourceUrl, dateKey);
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await sleep(1000 * attempt);
      }
    }
  }

  throw new Error(`${game.label} fallback ${dateKey}: ${lastError.message}`);
}

async function alignStartDraw(game, startDrawNumber, targetStartDateKey) {
  let currentDrawNumber = startDrawNumber;
  let currentRow = await fetchDrawByNumber(game, currentDrawNumber);

  while (currentRow.draw_date < targetStartDateKey) {
    currentDrawNumber += 1;
    currentRow = await fetchDrawByNumber(game, currentDrawNumber);
  }

  while (currentDrawNumber > 1) {
    const previousRow = await fetchDrawByNumber(game, currentDrawNumber - 1);
    if (previousRow.draw_date >= targetStartDateKey) {
      currentDrawNumber -= 1;
      currentRow = previousRow;
      continue;
    }
    break;
  }

  return {
    drawNumber: currentDrawNumber,
    row: currentRow,
  };
}

async function alignEndDraw(game, endDrawNumber, latestDrawNumber, targetEndDateKey) {
  let currentDrawNumber = endDrawNumber;
  let currentRow = await fetchDrawByNumber(game, currentDrawNumber);

  while (currentRow.draw_date > targetEndDateKey) {
    currentDrawNumber -= 1;
    currentRow = await fetchDrawByNumber(game, currentDrawNumber);
  }

  while (currentDrawNumber < latestDrawNumber) {
    const nextRow = await fetchDrawByNumber(game, currentDrawNumber + 1);
    if (nextRow.draw_date <= targetEndDateKey) {
      currentDrawNumber += 1;
      currentRow = nextRow;
      continue;
    }
    break;
  }

  return {
    drawNumber: currentDrawNumber,
    row: currentRow,
  };
}

async function fetchHistoryForRange(game, startDateKey, endDateKey) {
  const latestDrawNumber = await getLatestDrawNumber(game);
  const latestRow = await fetchDrawByNumber(game, latestDrawNumber);
  const latestDateValue = latestRow.draw_date_value;
  const rangeStartDate = new Date(`${startDateKey}T12:00:00`);
  const requestedRangeEndDate = new Date(`${endDateKey}T12:00:00`);
  const effectiveRangeEndDate =
    requestedRangeEndDate <= latestDateValue ? cloneDate(requestedRangeEndDate) : cloneDate(latestDateValue);

  const scheduledDrawsInRange = countScheduledDraws(game.key, rangeStartDate, effectiveRangeEndDate);

  if (scheduledDrawsInRange === 0) {
    return {
      latestDrawNumber,
      latestRow,
      startDrawNumber: null,
      endDrawNumber: null,
      rows: [],
    };
  }

  const drawsAfterRequestedEnd = countScheduledDraws(game.key, addDays(effectiveRangeEndDate, 1), latestDateValue);
  const estimatedEndDrawNumber = latestDrawNumber - drawsAfterRequestedEnd;
  const estimatedStartDrawNumber = estimatedEndDrawNumber - scheduledDrawsInRange + 1;

  const alignedStart = await alignStartDraw(game, estimatedStartDrawNumber, startDateKey);
  const alignedEnd = await alignEndDraw(game, estimatedEndDrawNumber, latestDrawNumber, formatDate(effectiveRangeEndDate));
  const startDrawNumber = alignedStart.drawNumber;
  const endDrawNumber = alignedEnd.drawNumber;

  if (startDrawNumber === null || endDrawNumber === null || startDrawNumber > endDrawNumber) {
    return {
      latestDrawNumber,
      latestRow,
      startDrawNumber,
      endDrawNumber,
      rows: [],
    };
  }

  const drawNumbers = [];
  for (let drawNumber = startDrawNumber; drawNumber <= endDrawNumber; drawNumber += 1) {
    drawNumbers.push(drawNumber);
  }

  const rowsFromWclc = await mapWithConcurrency(drawNumbers, concurrency, async (drawNumber) => fetchDrawByNumberOrNull(game, drawNumber));
  const availableRows = rowsFromWclc.filter(Boolean);
  const expectedDateKeys = getScheduledDateKeys(game.key, rangeStartDate, effectiveRangeEndDate);
  const existingDateKeys = new Set(availableRows.map((row) => row.draw_date));
  const missingDateKeys = expectedDateKeys.filter((dateKey) => !existingDateKeys.has(dateKey));
  const fallbackRows =
    missingDateKeys.length > 0
      ? await mapWithConcurrency(missingDateKeys, 1, async (dateKey) => fetchPlayNowFallback(game, dateKey))
      : [];

  const rows = [...availableRows, ...fallbackRows];
  rows.sort((left, right) => left.draw_number - right.draw_number);

  return {
    latestDrawNumber,
    latestRow,
    startDrawNumber,
    endDrawNumber,
    rows,
  };
}

const startDate = addYears(endDate, -yearsBack);
startDate.setHours(12, 0, 0, 0);
endDate.setHours(12, 0, 0, 0);

const today = new Date();
today.setHours(12, 0, 0, 0);
const effectiveEndDate = isSameCalendarDate(endDate, today) ? addDays(endDate, -1) : cloneDate(endDate);
const startDateKey = formatDate(startDate);
const endDateKey = formatDate(effectiveEndDate);

await fs.mkdir(outputDir, { recursive: true });

const [lotto649Result, lottoMaxResult] = await Promise.all([
  fetchHistoryForRange(GAME_CONFIGS.lotto649, startDateKey, endDateKey),
  fetchHistoryForRange(GAME_CONFIGS.lottomax, startDateKey, endDateKey),
]);

const lotto649Columns = [
  "game",
  "source",
  "source_url",
  "draw_number",
  "draw_date",
  "draw_day",
  "main_draw_label",
  "jackpot_amount",
  "main_1",
  "main_2",
  "main_3",
  "main_4",
  "main_5",
  "main_6",
  "bonus_number",
  "extra_number",
  "secondary_numbers",
  "secondary_ball_result",
];

const lottoMaxColumns = [
  "game",
  "source",
  "source_url",
  "draw_number",
  "draw_date",
  "draw_day",
  "jackpot_amount",
  "main_1",
  "main_2",
  "main_3",
  "main_4",
  "main_5",
  "main_6",
  "main_7",
  "bonus_number",
  "extra_number",
  "maxmillions_count",
  "maxmillions_numbers",
  "maxplus_count",
  "maxplus_numbers",
];

const rangeLabel = `${startDateKey}_to_${endDateKey}`;
const lotto649Path = path.join(outputDir, `lotto649_${rangeLabel}.csv`);
const lottoMaxPath = path.join(outputDir, `lottomax_${rangeLabel}.csv`);

await fs.writeFile(lotto649Path, rowsToCsv(lotto649Result.rows, lotto649Columns), "utf8");
await fs.writeFile(lottoMaxPath, rowsToCsv(lottoMaxResult.rows, lottoMaxColumns), "utf8");

console.log(
  JSON.stringify(
    {
      outputDir,
      startDate: startDateKey,
      requestedEndDate: formatDate(endDate),
      effectiveEndDate: endDateKey,
      requestDelayMs,
      concurrency,
      lotto649Rows: lotto649Result.rows.length,
      lotto649DrawRange: [lotto649Result.startDrawNumber, lotto649Result.endDrawNumber],
      lotto649LatestDrawNumber: lotto649Result.latestDrawNumber,
      lotto649Csv: lotto649Path,
      lottoMaxRows: lottoMaxResult.rows.length,
      lottoMaxDrawRange: [lottoMaxResult.startDrawNumber, lottoMaxResult.endDrawNumber],
      lottoMaxLatestDrawNumber: lottoMaxResult.latestDrawNumber,
      lottoMaxCsv: lottoMaxPath,
    },
    null,
    2,
  ),
);
