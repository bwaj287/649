import test from "node:test";
import assert from "node:assert/strict";

import {
  combinationCount,
  evaluateCoveragePortfolio,
  exactRandomDistinctPortfolioProbability,
  optimizeCoveragePortfolio,
} from "./portfolio_coverage_optimizer.mjs";

function candidate(numbers) {
  return {
    numbers: [...numbers].sort((left, right) => left - right),
    combinedScore: numbers.reduce((sum, number) => sum + number, 0) / 1000,
  };
}

test("6/49 combination and single-line jackpot probability are exact", () => {
  assert.equal(combinationCount(49, 6), 13983816);
  assert.equal(
    exactRandomDistinctPortfolioProbability(49, 6, 6, 1),
    1 / 13983816,
  );
});

test("more distinct random lines monotonically increase partial-hit coverage", () => {
  for (const threshold of [2, 3, 4, 6]) {
    const oneLine = exactRandomDistinctPortfolioProbability(49, 6, threshold, 1);
    const fourLines = exactRandomDistinctPortfolioProbability(49, 6, threshold, 4);
    const twelveLines = exactRandomDistinctPortfolioProbability(49, 6, threshold, 12);
    assert.ok(oneLine < fourLines);
    assert.ok(fourLines < twelveLines);
  }
});

test("optimizer returns distinct eligible lines and independent evaluation metrics", () => {
  const primary = candidate([1, 8, 17, 32, 40, 49]);
  const stable = candidate([4, 12, 21, 33, 41, 48]);
  const result = optimizeCoveragePortfolio({
    primaryCandidate: primary,
    stableCandidate: stable,
    requestedLineCount: 4,
    poolSize: 49,
    pickCount: 6,
    minimumNonBirthdayNumbers: 2,
    scoreNumbers: candidate,
    seed: "unit-test",
    trainingSampleCount: 1500,
    candidateCount: 50,
  });

  assert.equal(result.portfolio.length, 4);
  assert.equal(new Set(result.portfolio.map((line) => line.numbers.join("-"))).size, 4);
  assert.ok(
    result.portfolio.every(
      (line) => line.numbers.filter((number) => number > 31).length >= 2,
    ),
  );

  const evaluation = evaluateCoveragePortfolio({
    portfolio: result.portfolio,
    poolSize: 49,
    pickCount: 6,
    seed: "unit-test",
    evaluationSampleCount: 5000,
  });
  assert.equal(evaluation.method, "independent_monte_carlo_holdout_v1");
  for (const threshold of [2, 3, 4]) {
    assert.ok(evaluation.metrics[threshold].estimatedProbability > 0);
    assert.ok(evaluation.metrics[threshold].randomBaseline > 0);
    assert.ok(Number.isFinite(evaluation.metrics[threshold].liftPercentagePoints));
  }
});
