import { createServer } from "node:http";
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
const port = Number(args.port ?? 6490);
const shouldOpenBrowser = args.open !== "false";

let activeRun = null;

function jsonResponse(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body, null, 2));
}

function textResponse(response, statusCode, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function parseLastJson(text) {
  const match = text.match(/\{[\s\S]*\}\s*$/);
  if (!match) {
    throw new Error("没有从脚本输出里读到 JSON 结果。");
  }
  return JSON.parse(match[0]);
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readTextIfExists(filePath, fallback = "") {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

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

  const headers = rows.shift() ?? [];
  return rows
    .filter((values) => values.some((value) => value !== ""))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function isInsideRoot(filePath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedPath = path.resolve(filePath);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`);
}

async function readRecentDraws(report) {
  const sources = [
    {
      game: "Lotto Max",
      csvPath: report?.refresh?.lottoMaxCsv ?? report?.validationReports?.find((entry) => entry.game === "Lotto Max")?.csvPath,
      mainCount: 7,
    },
    {
      game: "Lotto 649",
      csvPath: report?.refresh?.lotto649Csv ?? report?.validationReports?.find((entry) => entry.game === "Lotto 649")?.csvPath,
      mainCount: 6,
    },
  ];

  return Promise.all(sources.map(async ({ game, csvPath, mainCount }) => {
    if (!csvPath || !isInsideRoot(csvPath)) return { game, draws: [] };

    try {
      const draws = parseCsv(await fs.readFile(csvPath, "utf8"))
        .sort((left, right) =>
          right.draw_date.localeCompare(left.draw_date) || Number(right.draw_number) - Number(left.draw_number)
        )
        .slice(0, 20)
        .map((row) => ({
          drawDate: row.draw_date,
          drawNumber: row.draw_number,
          drawDay: row.draw_day,
          mainNumbers: Array.from({ length: mainCount }, (_, index) => row[`main_${index + 1}`])
            .filter(Boolean)
            .join("-"),
          bonusNumber: row.bonus_number ?? "",
        }));
      return { game, draws };
    } catch (error) {
      if (error.code === "ENOENT") return { game, draws: [] };
      throw error;
    }
  }));
}

async function getStatus() {
  const predictionsPath = path.join(rootDir, "latest_weighted_predictions.json");
  const predictionsTextPath = path.join(rootDir, "latest_weighted_predictions.txt");
  const reportPath = path.join(rootDir, "refresh_report.json");

  const [predictions, predictionsText, report] = await Promise.all([
    readJsonIfExists(predictionsPath, []),
    readTextIfExists(predictionsTextPath, ""),
    readJsonIfExists(reportPath, null),
  ]);
  const recentDraws = await readRecentDraws(report);

  return {
    rootDir,
    isRunning: Boolean(activeRun),
    generatedAt: report?.refreshedAt ?? null,
    predictions,
    predictionsText,
    updateSummary: report?.updateSummary ?? [],
    predictionAudit: report?.predictionAudit ?? [],
    trainingRun: report?.trainingRun ?? null,
    validationReports: report?.validationReports ?? [],
    recentDraws,
    files: report?.predictionFiles ?? {
      json: predictionsPath,
      text: predictionsTextPath,
      report: reportPath,
    },
  };
}

function parsePortfolioLineCount(value) {
  if (value === null || value === undefined || value === "") return 4;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 4;
  return Math.max(1, Math.min(20, Math.floor(parsed)));
}

function runRefresh({ skipFetch, portfolioLineCount }) {
  if (activeRun) return activeRun;

  activeRun = new Promise((resolve, reject) => {
    const refreshScript = path.join(rootDir, "refresh_and_predict.mjs");
    const refreshArgs = [refreshScript];
    if (skipFetch) {
      refreshArgs.push("--skipFetch=true");
    }
    refreshArgs.push(`--portfolioLineCount=${parsePortfolioLineCount(portfolioLineCount)}`);

    const child = spawn(process.execPath, refreshArgs, {
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
        reject(new Error(`刷新脚本失败，退出码 ${code}\n${stderr}`));
        return;
      }

      try {
        resolve(parseLastJson(stdout));
      } catch (error) {
        reject(error);
      }
    });
  }).finally(() => {
    activeRun = null;
  });

  return activeRun;
}

async function serveUi(response) {
  const htmlPath = path.join(rootDir, "lottery_ui.html");
  const html = await fs.readFile(htmlPath, "utf8");
  textResponse(response, 200, html, "text/html; charset=utf-8");
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (request.method === "GET" && url.pathname === "/") {
      await serveUi(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      jsonResponse(response, 200, await getStatus());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/predict-local") {
      if (activeRun) {
        jsonResponse(response, 409, { error: "已有任务正在运行，请等它完成。" });
        return;
      }
      const result = await runRefresh({
        skipFetch: true,
        portfolioLineCount: url.searchParams.get("portfolioLines"),
      });
      jsonResponse(response, 200, { result, status: await getStatus() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/refresh") {
      if (activeRun) {
        jsonResponse(response, 409, { error: "已有任务正在运行，请等它完成。" });
        return;
      }
      const result = await runRefresh({
        skipFetch: false,
        portfolioLineCount: url.searchParams.get("portfolioLines"),
      });
      jsonResponse(response, 200, { result, status: await getStatus() });
      return;
    }

    textResponse(response, 404, "Not found");
  } catch (error) {
    jsonResponse(response, 500, {
      error: error.message,
      stack: args.debug === "true" ? error.stack : undefined,
    });
  }
}

function openBrowser(targetUrl) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", targetUrl], {
      cwd: rootDir,
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }

  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [targetUrl], {
    cwd: rootDir,
    detached: true,
    stdio: "ignore",
  }).unref();
}

const server = createServer((request, response) => {
  handleRequest(request, response);
});

server.listen(port, "127.0.0.1", () => {
  const targetUrl = `http://localhost:${port}`;
  console.log(`Lottery UI running: ${targetUrl}`);
  if (shouldOpenBrowser) {
    openBrowser(targetUrl);
  }
});
