# Lotto Weighted Predictor

A local reference tool for Lotto 649 and Lotto Max. It can:

- Download and refresh official draw history for Lotto 649 / Lotto Max.
- Validate local CSV data for missing draws, duplicate dates, and invalid main numbers.
- Generate next-draw reference numbers with a composite weighting model.
- Run a local browser UI with one-click refresh, prediction, data checks, and `ZH` / `English` language switching.

> Lottery draws are highly random. This project is for historical-statistical reference only. It cannot guarantee wins and should not be used as a reason to bet heavily.

## Quick Start

On Windows, double-click:

```text
start_lottery_ui.bat
```

Or launch the hidden-window starter:

```powershell
powershell -ExecutionPolicy Bypass -File .\launch_lottery_ui.ps1
```

Local UI:

```text
http://127.0.0.1:6490
```

The top-right language switch changes the UI between `ZH` and `English`. The selected language is saved in the current browser.

## Refresh And Predict

Refresh official data online and generate new predictions:

```powershell
node .\refresh_and_predict.mjs
```

Recalculate predictions using local CSV files only:

```powershell
node .\refresh_and_predict.mjs --skipFetch=true
```

Run with a specific cutoff date:

```powershell
node .\refresh_and_predict.mjs --endDate=2026-06-21
```

## Current Model

The current prediction model is `composite_weighted_v3_pattern_profile`. It combines:

- Recent activity: newer winning numbers receive higher exponentially decayed weight.
- Long-term hotness: numbers with historically above-expected frequency receive extra score.
- Cold-number rebound: numbers absent for longer periods receive a mild recovery score.
- Birthday-number avoidance: each pick keeps at least two `32+` numbers to reduce overlap with common birthday-based tickets.
- Pattern profile scoring: combinations are scored against historical odd/even balance, low/high balance, sum range, consecutive pairs, same-tail concentration, and repeat count from the latest draw.

Default model weights:

```text
recent_activity=0.46
long_term_hotness=0.34
cold_rebound=0.20
```

The UI shows one stable best pick plus five weighted random alternatives. The stable pick is deterministic; alternatives are resampled on each recalculation while still using the same score weights and birthday-number rule.

Each generated prediction includes a `prediction_generated_at` timestamp so old number sets are easy to identify.

## Data Files

The repository currently includes the latest official-history CSV files:

- `lotto649_2016-06-24_to_2026-06-23.csv`
- `lottomax_2016-06-24_to_2026-06-23.csv`

After a refresh, the scripts generate updated date-range CSV files and local output files:

- `latest_weighted_predictions.txt`
- `latest_weighted_predictions.csv`
- `latest_weighted_predictions.json`
- `refresh_report.json`

These generated output files are local runtime artifacts and are ignored by Git by default.

## Main Scripts

- `fetch_wclc_lottery_history.mjs`: downloads roughly 10 years of official draw history.
- `refresh_and_predict.mjs`: refreshes data, validates completeness, and generates predictions.
- `lottery_ui_server.mjs`: local UI server.
- `lottery_ui.html`: browser UI panel.
- `backtest_lottery_strategies.mjs`: rolling backtests for baseline strategies.
- `holdout_validation_lottery_strategies.mjs`: train/validation/test holdout validation.
- `analyze_backtest_significance.mjs`: significance and yearly performance analysis.

---

## 中文说明

这是一个本地运行的 Lotto 649 / Lotto Max 参考工具，可以：

- 下载并刷新 Lotto 649 / Lotto Max 官方开奖历史。
- 检查本地 CSV 数据是否缺期、重复或有无效主号码。
- 用组合权重模型生成下一期开奖参考号码。
- 通过本地浏览器 UI 一键刷新、预测、检查数据，并支持 `ZH` / `English` 语言切换。

> 彩票开奖结果高度随机。本工具只能做历史统计参考，不能保证中奖，也不应该作为重注依据。

## 快速启动

在 Windows 上双击：

```text
start_lottery_ui.bat
```

或者运行隐藏窗口启动器：

```powershell
powershell -ExecutionPolicy Bypass -File .\launch_lottery_ui.ps1
```

本地 UI 地址：

```text
http://127.0.0.1:6490
```

界面右上角可切换 `ZH` / `English`，语言选择会保存在当前浏览器中。

## 一键刷新和预测

联网刷新官方数据，并重新生成预测：

```powershell
node .\refresh_and_predict.mjs
```

只使用本地已有 CSV 重新预测：

```powershell
node .\refresh_and_predict.mjs --skipFetch=true
```

指定截止日期：

```powershell
node .\refresh_and_predict.mjs --endDate=2026-06-21
```

## 当前模型

当前预测模型为 `composite_weighted_v3_pattern_profile`，由几个思路组成：

- 近期活跃号：最近开奖影响更高，使用指数衰减权重。
- 长期热号：长期频率高于期望的号码加分。
- 冷号回补：久未出现的号码温和加分。
- 避免全生日号：每组至少保留 2 个 `32+` 号码，减少与生日投注人群平分奖金的概率。
- 号码形态评分：组合会参考历史常见的奇偶比例、大小号比例、和值范围、连号数量、同尾号集中度、与最近一期重号数量。

默认权重：

```text
recent_activity=0.46
long_term_hotness=0.34
cold_rebound=0.20
```

UI 会显示 1 组稳定主推荐和 5 组加权随机备选。主推荐是确定性的；备选会在每次重新预测时重新抽样，但仍使用同一套权重和生日号规则。

每次生成的预测都会带 `prediction_generated_at` 时间戳，方便区分旧号码，避免重复使用。

## 数据文件

当前提交包含最新官方历史 CSV：

- `lotto649_2016-06-24_to_2026-06-23.csv`
- `lottomax_2016-06-24_to_2026-06-23.csv`

刷新后脚本会生成新的带日期范围的 CSV，并输出：

- `latest_weighted_predictions.txt`
- `latest_weighted_predictions.csv`
- `latest_weighted_predictions.json`
- `refresh_report.json`

这些输出文件属于本地运行结果，默认不提交到 Git。

## 主要脚本

- `fetch_wclc_lottery_history.mjs`：从官方数据源抓取近 10 年开奖记录。
- `refresh_and_predict.mjs`：刷新数据、完整性检查、生成预测。
- `lottery_ui_server.mjs`：本地 UI 服务。
- `lottery_ui.html`：浏览器 UI 面板。
- `backtest_lottery_strategies.mjs`：滚动回测基础策略。
- `holdout_validation_lottery_strategies.mjs`：训练/验证/测试留出验证。
- `analyze_backtest_significance.mjs`：显著性和年度表现分析。
