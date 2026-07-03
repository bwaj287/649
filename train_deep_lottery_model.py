import argparse
import csv
import json
import math
import random
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

try:
    import torch
    from torch import nn
    from torch.utils.data import DataLoader, TensorDataset
except ImportError as error:
    print(
        json.dumps(
            {
                "status": "missing_dependency",
                "dependency": "torch",
                "message": str(error),
            },
            indent=2,
        )
    )
    raise SystemExit(0)


MAX_POOL_SIZE = 52

GAME_CONFIGS = {
    "lotto649": {
        "label": "Lotto 649",
        "pick_count": 6,
        "default_half_life": 156,
        "minimum_non_birthday_numbers": 2,
        "main_columns": ["main_1", "main_2", "main_3", "main_4", "main_5", "main_6"],
        "draw_days": {2, 5},  # Python date.weekday(): Wednesday=2, Saturday=5
    },
    "lottomax": {
        "label": "Lotto Max",
        "pick_count": 7,
        "default_half_life": 78,
        "minimum_non_birthday_numbers": 3,
        "main_columns": ["main_1", "main_2", "main_3", "main_4", "main_5", "main_6", "main_7"],
        "draw_days": {1, 4},  # Tuesday=1, Friday=4
    },
}


def parse_args():
    parser = argparse.ArgumentParser(description="Train a GPU PyTorch lottery model.")
    parser.add_argument("--rootDir", default=".")
    parser.add_argument("--outputDir", default="")
    parser.add_argument("--configOutput", default="")
    parser.add_argument("--epochs", type=int, default=160)
    parser.add_argument("--batchSize", type=int, default=64)
    parser.add_argument("--warmupDraws", type=int, default=104)
    parser.add_argument("--learningRate", type=float, default=0.002)
    parser.add_argument("--patience", type=int, default=28)
    parser.add_argument("--seed", type=int, default=649)
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    parser.add_argument("--writeConfig", default="true")
    return parser.parse_args()


def iso_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_date(value):
    return datetime.strptime(value, "%Y-%m-%d").date()


def format_date(value):
    return value.isoformat()


def pool_size_for_date(game_key, draw_date):
    if game_key == "lotto649":
        return 49
    if draw_date >= "2026-04-14":
        return 52
    if draw_date >= "2019-05-14":
        return 50
    return 49


def next_draw_date(game_key, latest_date_key):
    current = parse_date(latest_date_key) + timedelta(days=1)
    valid_days = GAME_CONFIGS[game_key]["draw_days"]
    while current.weekday() not in valid_days:
        current += timedelta(days=1)
    return format_date(current)


def find_latest_csv(root_dir, game_key):
    pattern = re.compile(rf"^{re.escape(game_key)}_(\d{{4}}-\d{{2}}-\d{{2}})_to_(\d{{4}}-\d{{2}}-\d{{2}})\.csv$")
    candidates = []
    for path in Path(root_dir).glob(f"{game_key}_*.csv"):
        match = pattern.match(path.name)
        if not match:
            continue
        candidates.append(
            {
                "path": path,
                "start": match.group(1),
                "end": match.group(2),
                "mtime": path.stat().st_mtime,
            }
        )
    if not candidates:
        raise FileNotFoundError(f"No {game_key} CSV found in {root_dir}")
    candidates.sort(key=lambda item: (item["end"], item["start"], item["mtime"]), reverse=True)
    return candidates[0]["path"]


def read_rows(csv_path):
    with open(csv_path, "r", encoding="utf-8-sig", newline="") as file:
        rows = list(csv.DictReader(file))
    return sorted(rows, key=lambda row: (row["draw_date"], int(row["draw_number"])))


def main_numbers(row, config):
    return sorted(int(row[column]) for column in config["main_columns"] if str(row.get(column, "")).strip())


def normalize(values):
    values = np.asarray(values, dtype=np.float32)
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return np.zeros_like(values, dtype=np.float32)
    minimum = float(finite.min())
    maximum = float(finite.max())
    if math.isclose(minimum, maximum):
        return np.zeros_like(values, dtype=np.float32)
    return ((values - minimum) / (maximum - minimum)).astype(np.float32)


def count_consecutive_pairs(numbers):
    total = 0
    for index in range(1, len(numbers)):
        if numbers[index] == numbers[index - 1] + 1:
            total += 1
    return total


def max_same_tail_count(numbers):
    if not numbers:
        return 0
    tails = Counter(number % 10 for number in numbers)
    return max(tails.values())


def describe_combination(numbers, pool_size, previous_numbers=None):
    previous = set(previous_numbers or [])
    high_cutoff = pool_size // 2
    return {
        "sum": sum(numbers),
        "odd": sum(1 for number in numbers if number % 2),
        "high": sum(1 for number in numbers if number > high_cutoff),
        "consecutive": count_consecutive_pairs(numbers),
        "same_tail": max_same_tail_count(numbers),
        "repeat_last": sum(1 for number in numbers if number in previous),
        "non_birthday": sum(1 for number in numbers if number > 31),
        "low_month": sum(1 for number in numbers if number <= 12),
        "round_number": sum(1 for number in numbers if number % 5 == 0 or number % 10 == 0),
    }


def build_pattern_profile(rows, config, game_key, pool_size):
    observations = []
    for index, row in enumerate(rows):
        row_pool_size = pool_size_for_date(game_key, row["draw_date"])
        numbers = main_numbers(row, config)
        if any(number < 1 or number > row_pool_size for number in numbers):
            continue
        previous_numbers = main_numbers(rows[index - 1], config) if index > 0 else []
        observations.append(describe_combination(numbers, row_pool_size, previous_numbers))

    if not observations:
        return {
            "sum_range": [0, pool_size * config["pick_count"]],
            "odd_range": [0, config["pick_count"]],
            "high_range": [0, config["pick_count"]],
            "max_consecutive": 1,
            "max_same_tail": 2,
            "max_recent_repeats": 1,
            "latest_numbers": [],
        }

    def quantile(name, ratio):
        return float(np.quantile([entry[name] for entry in observations], ratio))

    return {
        "sum_range": [round(quantile("sum", 0.15)), round(quantile("sum", 0.85))],
        "odd_range": [math.floor(quantile("odd", 0.15)), math.ceil(quantile("odd", 0.85))],
        "high_range": [math.floor(quantile("high", 0.15)), math.ceil(quantile("high", 0.85))],
        "max_consecutive": max(1, math.ceil(quantile("consecutive", 0.85))),
        "max_same_tail": max(2, math.ceil(quantile("same_tail", 0.85))),
        "max_recent_repeats": max(1, math.ceil(quantile("repeat_last", 0.85))),
        "latest_numbers": main_numbers(rows[-1], config),
    }


def build_features(history_rows, config, game_key, target_date_key):
    pool_size = pool_size_for_date(game_key, target_date_key)
    pick_count = config["pick_count"]
    latest_index = len(history_rows) - 1
    recent_observed = np.zeros(MAX_POOL_SIZE, dtype=np.float32)
    recent_expected = np.zeros(MAX_POOL_SIZE, dtype=np.float32)
    long_observed = np.zeros(MAX_POOL_SIZE, dtype=np.float32)
    long_expected = np.zeros(MAX_POOL_SIZE, dtype=np.float32)
    available_draws = np.zeros(MAX_POOL_SIZE, dtype=np.float32)
    last_seen_available = np.zeros(MAX_POOL_SIZE, dtype=np.float32)
    short_counts = np.zeros(MAX_POOL_SIZE, dtype=np.float32)
    medium_counts = np.zeros(MAX_POOL_SIZE, dtype=np.float32)
    half_life = float(config["default_half_life"])

    for row_index, row in enumerate(history_rows):
        age = latest_index - row_index
        weight = 0.5 ** (age / half_life)
        row_pool_size = pool_size_for_date(game_key, row["draw_date"])
        expected = pick_count / row_pool_size
        upper = min(pool_size, row_pool_size, MAX_POOL_SIZE)

        for number_index in range(upper):
            available_draws[number_index] += 1
            recent_expected[number_index] += weight * expected
            long_expected[number_index] += expected

        for number in main_numbers(row, config):
            if 1 <= number <= upper:
                number_index = number - 1
                recent_observed[number_index] += weight
                long_observed[number_index] += 1
                last_seen_available[number_index] = available_draws[number_index]
                if age < 8:
                    short_counts[number_index] += 1
                if age < 32:
                    medium_counts[number_index] += 1

    expected_gap = max(1.0, pool_size / pick_count)
    cold_age = np.maximum(0.0, available_draws - last_seen_available)
    recent_ratio = np.divide(recent_observed, np.maximum(recent_expected, 1e-6))
    long_ratio = np.divide(long_observed, np.maximum(long_expected, 1e-6))
    cold_ratio = np.minimum(cold_age / (expected_gap * 2.5), 1.6)
    recent_score = normalize(recent_ratio)
    long_score = normalize(long_ratio)
    cold_score = normalize(cold_ratio)
    latest_numbers = main_numbers(history_rows[-1], config)
    latest_set = set(latest_numbers)
    previous_numbers = main_numbers(history_rows[-2], config) if len(history_rows) >= 2 else []
    latest_features = describe_combination(latest_numbers, pool_size, previous_numbers)

    feature_rows = []
    for number in range(1, MAX_POOL_SIZE + 1):
        available = 1.0 if number <= pool_size else 0.0
        number_index = number - 1
        feature_rows.append(
            [
                available,
                number / MAX_POOL_SIZE,
                1.0 if number <= 31 else 0.0,
                1.0 if number <= 12 else 0.0,
                1.0 if number % 5 == 0 or number % 10 == 0 else 0.0,
                1.0 if number in latest_set else 0.0,
                recent_score[number_index],
                long_score[number_index],
                cold_score[number_index],
                min(cold_age[number_index] / (expected_gap * 4.0), 1.0),
                short_counts[number_index] / max(1.0, min(8, len(history_rows))),
                medium_counts[number_index] / max(1.0, min(32, len(history_rows))),
                pool_size / MAX_POOL_SIZE,
                pick_count / 7.0,
                latest_features["sum"] / max(1.0, pool_size * pick_count),
                latest_features["odd"] / pick_count,
                latest_features["high"] / pick_count,
                latest_features["consecutive"] / pick_count,
                latest_features["same_tail"] / pick_count,
                latest_features["repeat_last"] / pick_count,
                latest_features["non_birthday"] / pick_count,
                latest_features["low_month"] / pick_count,
                latest_features["round_number"] / pick_count,
            ]
        )

    return np.asarray(feature_rows, dtype=np.float32).reshape(-1)


def build_target(row, config):
    target = np.zeros(MAX_POOL_SIZE, dtype=np.float32)
    for number in main_numbers(row, config):
        if 1 <= number <= MAX_POOL_SIZE:
            target[number - 1] = 1.0
    return target


def build_dataset(rows, config, game_key, warmup_draws):
    features = []
    targets = []
    dates = []
    for index in range(warmup_draws, len(rows)):
        target = rows[index]
        history = rows[:index]
        features.append(build_features(history, config, game_key, target["draw_date"]))
        targets.append(build_target(target, config))
        dates.append(target["draw_date"])

    return np.asarray(features, dtype=np.float32), np.asarray(targets, dtype=np.float32), dates


class LotteryNet(nn.Module):
    def __init__(self, input_dim, output_dim):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, 384),
            nn.LayerNorm(384),
            nn.SiLU(),
            nn.Dropout(0.18),
            nn.Linear(384, 256),
            nn.LayerNorm(256),
            nn.SiLU(),
            nn.Dropout(0.14),
            nn.Linear(256, 160),
            nn.SiLU(),
            nn.Linear(160, output_dim),
        )

    def forward(self, value):
        return self.net(value)


def split_indices(size):
    train_end = max(1, int(size * 0.72))
    validation_end = max(train_end + 1, int(size * 0.86))
    validation_end = min(validation_end, size)
    return {
        "train": np.arange(0, train_end),
        "validation": np.arange(train_end, validation_end),
        "test": np.arange(validation_end, size),
    }


def count_hits(predicted, actual):
    return len(set(predicted) & set(actual))


def top_numbers_from_logits(logits, pool_size, pick_count):
    scores = logits[:pool_size]
    order = np.argsort(scores)[::-1]
    return sorted(int(index + 1) for index in order[:pick_count])


def evaluate_model(model, x_values, y_values, dates, rows, config, game_key, device, indices, warmup_draws):
    if len(indices) == 0:
        return {"draws": 0, "avg_hits_per_draw": 0, "rate_at_least_2": 0, "rate_at_least_3": 0}

    model.eval()
    hits = []
    with torch.no_grad():
        for idx in indices:
            tensor = torch.from_numpy(x_values[idx : idx + 1]).to(device)
            logits = model(tensor).detach().cpu().numpy()[0]
            target_row = rows[warmup_draws + idx]
            pool_size = pool_size_for_date(game_key, dates[idx])
            predicted = top_numbers_from_logits(logits, pool_size, config["pick_count"])
            actual = main_numbers(target_row, config)
            hits.append(count_hits(predicted, actual))

    hits_array = np.asarray(hits, dtype=np.float32)
    return {
        "draws": int(len(hits)),
        "avg_hits_per_draw": round(float(hits_array.mean()), 6),
        "at_least_2": int((hits_array >= 2).sum()),
        "at_least_3": int((hits_array >= 3).sum()),
        "at_least_4": int((hits_array >= 4).sum()),
        "rate_at_least_2": round(float((hits_array >= 2).mean()), 6),
        "rate_at_least_3": round(float((hits_array >= 3).mean()), 6),
        "rate_at_least_4": round(float((hits_array >= 4).mean()), 6),
    }


def train_game(game_key, config, rows, csv_path, args, device):
    warmup = min(args.warmupDraws, max(8, len(rows) // 4))
    x_values, y_values, dates = build_dataset(rows, config, game_key, warmup)
    if len(x_values) < 20:
        raise ValueError(f"Not enough rows to train {config['label']}")

    splits = split_indices(len(x_values))
    x_train = torch.from_numpy(x_values[splits["train"]]).to(device)
    y_train = torch.from_numpy(y_values[splits["train"]]).to(device)
    train_positions = splits["train"]
    recency = np.linspace(0.75, 1.25, len(train_positions), dtype=np.float32)
    w_train = torch.from_numpy(recency).to(device)

    positives = y_values[splits["train"]].sum(axis=0)
    negatives = len(splits["train"]) - positives
    pos_weight_np = np.clip(negatives / np.maximum(positives, 1.0), 1.0, 12.0).astype(np.float32)
    pos_weight = torch.from_numpy(pos_weight_np).to(device)

    dataset = TensorDataset(x_train, y_train, w_train)
    loader = DataLoader(dataset, batch_size=args.batchSize, shuffle=True)
    model = LotteryNet(x_values.shape[1], MAX_POOL_SIZE).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learningRate, weight_decay=0.015)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight, reduction="none")

    validation_x = torch.from_numpy(x_values[splits["validation"]]).to(device)
    validation_y = torch.from_numpy(y_values[splits["validation"]]).to(device)
    best_state = None
    best_validation_loss = float("inf")
    best_epoch = 0
    epochs_without_improvement = 0

    for epoch in range(1, args.epochs + 1):
        model.train()
        for batch_x, batch_y, batch_w in loader:
            optimizer.zero_grad(set_to_none=True)
            logits = model(batch_x)
            loss_matrix = loss_fn(logits, batch_y)
            loss = (loss_matrix.mean(dim=1) * batch_w).mean()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 3.0)
            optimizer.step()

        model.eval()
        with torch.no_grad():
            if len(splits["validation"]) > 0:
                validation_logits = model(validation_x)
                validation_loss = float(loss_fn(validation_logits, validation_y).mean().detach().cpu())
            else:
                validation_loss = float(loss.detach().cpu())

        if validation_loss + 1e-6 < best_validation_loss:
            best_validation_loss = validation_loss
            best_epoch = epoch
            best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
            epochs_without_improvement = 0
        else:
            epochs_without_improvement += 1
            if epochs_without_improvement >= args.patience:
                break

    if best_state:
        model.load_state_dict(best_state)

    validation = evaluate_model(
        model,
        x_values,
        y_values,
        dates,
        rows,
        config,
        game_key,
        device,
        splits["validation"],
        warmup,
    )
    test = evaluate_model(model, x_values, y_values, dates, rows, config, game_key, device, splits["test"], warmup)

    next_date_key = next_draw_date(game_key, rows[-1]["draw_date"])
    next_pool_size = pool_size_for_date(game_key, next_date_key)
    next_features = build_features(rows, config, game_key, next_date_key)
    model.eval()
    with torch.no_grad():
        logits = model(torch.from_numpy(next_features.reshape(1, -1)).to(device))
        probabilities = torch.sigmoid(logits).detach().cpu().numpy()[0]

    probability_map = {
        str(number): round(float(probabilities[number - 1]), 8)
        for number in range(1, next_pool_size + 1)
    }
    top_numbers = sorted(
        [
            {
                "number": number,
                "probability": probability_map[str(number)],
            }
            for number in range(1, next_pool_size + 1)
        ],
        key=lambda item: item["probability"],
        reverse=True,
    )[:16]

    return {
        "label": config["label"],
        "sourceCsvPath": str(csv_path),
        "sourceRows": len(rows),
        "sourceFirstDrawDate": rows[0]["draw_date"],
        "sourceLastDrawDate": rows[-1]["draw_date"],
        "nextDrawDate": next_date_key,
        "device": str(device),
        "epochsRequested": args.epochs,
        "epochsCompleted": best_epoch,
        "bestValidationLoss": round(best_validation_loss, 8),
        "warmupDraws": warmup,
        "halfLife": config["default_half_life"],
        "minimumNonBirthdayNumbers": config["minimum_non_birthday_numbers"],
        "scoreWeights": {
            "recentActivity": 0.2,
            "longTermHotness": 0.15,
            "coldRebound": 0.15,
            "deepLearning": 0.5,
        },
        "combinationScoreWeights": {
            "numberScore": 0.6,
            "patternProfile": 0.24,
            "crowdAvoidance": 0.16,
        },
        "deepLearning": {
            "model": "pytorch_multilabel_mlp_v1",
            "device": str(device),
            "cudaDeviceName": torch.cuda.get_device_name(0) if device.type == "cuda" else "",
            "featureRules": [
                "recent_activity",
                "long_term_hotness",
                "cold_number_rebound",
                "birthday_and_low_month_avoidance",
                "round_number_and_obvious_pattern_avoidance",
                "odd_even_high_low_sum_tail_repeat_profile",
            ],
            "probabilities": probability_map,
            "topNumbers": top_numbers,
            "validation": validation,
            "test": test,
        },
        "validation": validation,
        "test": test,
    }


def main():
    args = parse_args()
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    if hasattr(torch, "set_float32_matmul_precision"):
        torch.set_float32_matmul_precision("high")

    root_dir = Path(args.rootDir).resolve()
    output_dir = Path(args.outputDir).resolve() if args.outputDir else root_dir / "train_results"
    output_dir.mkdir(parents=True, exist_ok=True)
    config_output = Path(args.configOutput).resolve() if args.configOutput else root_dir / "trained_model_config.json"

    if args.device == "cuda":
        device = torch.device("cuda")
    elif args.device == "cpu":
        device = torch.device("cpu")
    else:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    if device.type == "cuda":
        torch.backends.cudnn.benchmark = True

    generated_at = iso_now()
    games = {}
    for game_key, config in GAME_CONFIGS.items():
        csv_path = find_latest_csv(root_dir, game_key)
        rows = read_rows(csv_path)
        games[game_key] = train_game(game_key, dict(config), rows, csv_path, args, device)

    trained_config = {
        "generatedAt": generated_at,
        "model": "deep_lottery_net_v1_gpu" if device.type == "cuda" else "deep_lottery_net_v1_cpu",
        "trainingMethod": "pytorch_multilabel_next_draw_with_rule_features",
        "device": str(device),
        "cudaAvailable": bool(torch.cuda.is_available()),
        "cudaDeviceName": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "",
        "rules": [
            "recent active numbers get explicit feature inputs",
            "long-term hot numbers get explicit feature inputs",
            "cold-number rebound gets explicit feature inputs",
            "birthday, low-month, round-number, and obvious-pattern sharing risk is modeled",
            "historical odd/even, high/low, sum, consecutive, same-tail, and repeat profiles are modeled",
        ],
        "search": {
            "seed": args.seed,
            "epochs": args.epochs,
            "batchSize": args.batchSize,
            "learningRate": args.learningRate,
            "patience": args.patience,
        },
        "games": games,
    }

    summary_path = output_dir / "deep_training_summary.json"
    summary_path.write_text(json.dumps(trained_config, indent=2), encoding="utf-8")
    if args.writeConfig != "false":
        config_output.write_text(json.dumps(trained_config, indent=2), encoding="utf-8")

    print(
        json.dumps(
            {
                "status": "trained",
                "generatedAt": generated_at,
                "model": trained_config["model"],
                "device": str(device),
                "cudaAvailable": trained_config["cudaAvailable"],
                "cudaDeviceName": trained_config["cudaDeviceName"],
                "summaryPath": str(summary_path),
                "configOutputPath": str(config_output) if args.writeConfig != "false" else None,
                "games": {
                    key: {
                        "label": value["label"],
                        "device": value["device"],
                        "epochsCompleted": value["epochsCompleted"],
                        "bestValidationLoss": value["bestValidationLoss"],
                        "validation": value["validation"],
                        "test": value["test"],
                        "topDeepLearningNumbers": value["deepLearning"]["topNumbers"][:8],
                    }
                    for key, value in games.items()
                },
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
