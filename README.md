# Lotto Weighted Predictor

本项目是一个本地运行的 Lotto 参考工具，用于：

- 下载并刷新 Lotto 649 / Lotto Max 官方开奖历史
- 检查本地 CSV 数据是否缺期、重复或有无效主号码
- 用组合权重模型生成下一期开奖参考号码
- 通过本地 UI 面板一键刷新和预测

> 说明：彩票开奖结果高度随机。本工具只能做历史统计参考，不能保证中奖，也不应该用于重注。

## 快速启动

在 Windows 上双击：

```text
start_lottery_ui.bat
```

或者运行隐藏窗口启动器：

```powershell
powershell -ExecutionPolicy Bypass -File .\launch_lottery_ui.ps1
```

UI 地址：

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

当前预测模型为 `composite_weighted_v2`，由四个思路组成：

- 近期活跃号：最近开奖影响更高，使用指数衰减权重
- 长期热号：长期频率高于期望的号码加分
- 冷号回补：久未出现的号码温和加分
- 避免全生日号：每组至少保留 2 个 `32+` 号码，减少与生日投注人群平分奖金的概率

默认权重：

```text
recent_activity=0.46
long_term_hotness=0.34
cold_rebound=0.20
```

## 数据文件

当前提交包含最新官方历史 CSV：

- `lotto649_2016-06-22_to_2026-06-21.csv`
- `lottomax_2016-06-22_to_2026-06-21.csv`

刷新后脚本会生成新的带日期范围的 CSV，并输出：

- `latest_weighted_predictions.txt`
- `latest_weighted_predictions.csv`
- `latest_weighted_predictions.json`
- `refresh_report.json`

这些输出文件属于本地运行结果，默认不提交到 Git。

## 主要脚本

- `fetch_wclc_lottery_history.mjs`：从官方数据源抓取近 10 年开奖记录
- `refresh_and_predict.mjs`：刷新数据、完整性检查、生成预测
- `lottery_ui_server.mjs`：本地 UI 服务
- `lottery_ui.html`：浏览器 UI 面板
- `backtest_lottery_strategies.mjs`：滚动回测基础策略
- `holdout_validation_lottery_strategies.mjs`：训练/验证/测试留出验证
- `analyze_backtest_significance.mjs`：显著性和年度表现分析
