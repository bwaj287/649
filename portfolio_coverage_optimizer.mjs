const DEFAULT_THRESHOLDS = [2, 3, 4];
const DEFAULT_THRESHOLD_WEIGHTS = new Map([
  [2, 0.2],
  [3, 0.45],
  [4, 0.35],
]);

export function combinationCount(poolSize, pickCount) {
  const smallerSide = Math.min(pickCount, poolSize - pickCount);
  let result = 1;
  for (let index = 1; index <= smallerSide; index += 1) {
    result = (result * (poolSize - smallerSide + index)) / index;
  }
  return Math.round(result);
}

function hashSeed(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededRandom(seed) {
  let state = hashSeed(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function drawUniformCombination(poolSize, pickCount, random) {
  const selected = new Set();
  for (let cursor = poolSize - pickCount + 1; cursor <= poolSize; cursor += 1) {
    const candidate = 1 + Math.floor(random() * cursor);
    selected.add(selected.has(candidate) ? cursor : candidate);
  }
  return [...selected].sort((left, right) => left - right);
}

function drawEligibleCombination(
  poolSize,
  pickCount,
  minimumNonBirthdayNumbers,
  random,
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const numbers = drawUniformCombination(poolSize, pickCount, random);
    if (numbers.filter((number) => number > 31).length >= minimumNonBirthdayNumbers) {
      return numbers;
    }
  }
  throw new Error("Could not generate a portfolio line that satisfies the sharing rule.");
}

function numberKey(numbers) {
  return [...numbers].sort((left, right) => left - right).join("-");
}

function numbersToMask(numbers) {
  let low = 0;
  let high = 0;
  for (const number of numbers) {
    if (number <= 32) {
      low = (low | (1 << (number - 1))) >>> 0;
    } else {
      high = (high | (1 << (number - 33))) >>> 0;
    }
  }
  return { low, high };
}

function popcount32(value) {
  let bits = value >>> 0;
  bits -= (bits >>> 1) & 0x55555555;
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function overlapCount(left, right) {
  return popcount32(left.low & right.low) + popcount32(left.high & right.high);
}

function numberOverlapCount(leftNumbers, rightNumbers) {
  const right = new Set(rightNumbers);
  return leftNumbers.filter((number) => right.has(number)).length;
}

function generateDrawMasks(poolSize, pickCount, sampleCount, seed) {
  const random = createSeededRandom(seed);
  return Array.from({ length: sampleCount }, () =>
    numbersToMask(drawUniformCombination(poolSize, pickCount, random)),
  );
}

function buildThresholdBitsets(lineMask, drawMasks, thresholds) {
  const wordCount = Math.ceil(drawMasks.length / 32);
  const bitsets = new Map(
    thresholds.map((threshold) => [threshold, new Uint32Array(wordCount)]),
  );

  for (let drawIndex = 0; drawIndex < drawMasks.length; drawIndex += 1) {
    const hits = overlapCount(lineMask, drawMasks[drawIndex]);
    const wordIndex = drawIndex >>> 5;
    const bit = 1 << (drawIndex & 31);
    for (const threshold of thresholds) {
      if (hits >= threshold) bitsets.get(threshold)[wordIndex] |= bit;
    }
  }
  return bitsets;
}

function mergeBitsets(target, source) {
  for (let index = 0; index < target.length; index += 1) {
    target[index] |= source[index];
  }
}

function countNewBits(candidate, covered) {
  let count = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    count += popcount32(candidate[index] & ~covered[index]);
  }
  return count;
}

function singleLineWinningCombinationCount(poolSize, pickCount, threshold) {
  let winningCombinations = 0;
  for (let hits = threshold; hits <= pickCount; hits += 1) {
    const missed = pickCount - hits;
    if (missed > poolSize - pickCount) continue;
    winningCombinations +=
      combinationCount(pickCount, hits) *
      combinationCount(poolSize - pickCount, missed);
  }
  return winningCombinations;
}

export function exactRandomDistinctPortfolioProbability(
  poolSize,
  pickCount,
  threshold,
  lineCount,
) {
  const totalLines = combinationCount(poolSize, pickCount);
  const winningLines = singleLineWinningCombinationCount(poolSize, pickCount, threshold);
  const effectiveLineCount = Math.max(0, Math.min(Math.floor(lineCount), totalLines));
  if (effectiveLineCount === 0) return 0;
  if (winningLines >= totalLines) return 1;
  if (effectiveLineCount === 1) return winningLines / totalLines;
  if (effectiveLineCount > totalLines - winningLines) return 1;

  let logNoWinningLineProbability = 0;
  for (let index = 0; index < effectiveLineCount; index += 1) {
    logNoWinningLineProbability += Math.log1p(-winningLines / (totalLines - index));
  }
  return -Math.expm1(logNoWinningLineProbability);
}

function addCandidate(candidates, seen, candidate) {
  if (!candidate?.numbers) return;
  const key = numberKey(candidate.numbers);
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push(candidate);
}

export function optimizeCoveragePortfolio({
  primaryCandidate,
  stableCandidate,
  requestedLineCount,
  poolSize,
  pickCount,
  minimumNonBirthdayNumbers = 0,
  scoreNumbers,
  generateWeightedCandidate,
  seed,
  trainingSampleCount = 24000,
  candidateCount,
  thresholds = DEFAULT_THRESHOLDS,
}) {
  const targetLineCount = Math.max(1, Math.min(Math.floor(requestedLineCount), 20));
  if (targetLineCount === 1) {
    return {
      portfolio: [primaryCandidate],
      optimization: {
        method: "single_line_no_optimization",
        trainingSampleCount: 0,
        candidateCount: 1,
      },
    };
  }

  const random = createSeededRandom(`${seed}:candidates`);
  const desiredCandidateCount = Math.max(
    targetLineCount * 20,
    candidateCount ?? Math.min(900, 420 + targetLineCount * 35),
  );
  const candidates = [];
  const seen = new Set([numberKey(primaryCandidate.numbers)]);
  addCandidate(candidates, seen, stableCandidate);

  for (let attempt = 0; candidates.length < desiredCandidateCount && attempt < desiredCandidateCount * 8; attempt += 1) {
    if (attempt % 4 === 0 && generateWeightedCandidate) {
      addCandidate(candidates, seen, generateWeightedCandidate());
      continue;
    }
    const numbers = drawEligibleCombination(
      poolSize,
      pickCount,
      minimumNonBirthdayNumbers,
      random,
    );
    addCandidate(candidates, seen, scoreNumbers(numbers));
  }

  const drawMasks = generateDrawMasks(
    poolSize,
    pickCount,
    trainingSampleCount,
    `${seed}:optimization-draws`,
  );
  const wordCount = Math.ceil(trainingSampleCount / 32);
  const covered = new Map(
    thresholds.map((threshold) => [threshold, new Uint32Array(wordCount)]),
  );
  const primaryCoverage = buildThresholdBitsets(
    numbersToMask(primaryCandidate.numbers),
    drawMasks,
    thresholds,
  );
  for (const threshold of thresholds) {
    mergeBitsets(covered.get(threshold), primaryCoverage.get(threshold));
  }

  const candidateCoverage = candidates.map((candidate) =>
    buildThresholdBitsets(numbersToMask(candidate.numbers), drawMasks, thresholds),
  );
  const randomBaselines = new Map(
    thresholds.map((threshold) => [
      threshold,
      exactRandomDistinctPortfolioProbability(
        poolSize,
        pickCount,
        threshold,
        targetLineCount,
      ),
    ]),
  );
  const selected = [primaryCandidate];
  const available = new Set(candidates.map((_, index) => index));
  const preferredMaximumOverlap =
    targetLineCount <= 4 && targetLineCount * pickCount <= poolSize ? 0 : 1;

  while (selected.length < targetLineCount && available.size > 0) {
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    const preferredOverlapIndexes = [...available].filter((index) =>
      selected.every(
        (line) =>
          numberOverlapCount(candidates[index].numbers, line.numbers) <=
          preferredMaximumOverlap,
      ),
    );
    const lowOverlapIndexes = [...available].filter((index) =>
      selected.every(
        (line) => numberOverlapCount(candidates[index].numbers, line.numbers) <= 1,
      ),
    );
    const searchIndexes = preferredOverlapIndexes.length > 0
      ? preferredOverlapIndexes
      : lowOverlapIndexes.length > 0
        ? lowOverlapIndexes
        : available;
    for (const index of searchIndexes) {
      let gainScore = 0;
      for (const threshold of thresholds) {
        const gainRate =
          countNewBits(candidateCoverage[index].get(threshold), covered.get(threshold)) /
          trainingSampleCount;
        const thresholdWeight = DEFAULT_THRESHOLD_WEIGHTS.get(threshold) ?? 1 / thresholds.length;
        gainScore +=
          thresholdWeight * gainRate / Math.max(randomBaselines.get(threshold), 0.000001);
      }

      // Historical/model score is only a deterministic tie-breaker after coverage.
      const tieBreaker = 0.0001 * Number(candidates[index].combinedScore ?? 0);
      const score = gainScore + tieBreaker;
      if (
        score > bestScore ||
        (score === bestScore && numberKey(candidates[index].numbers) < numberKey(candidates[bestIndex]?.numbers ?? []))
      ) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex < 0) break;
    selected.push(candidates[bestIndex]);
    for (const threshold of thresholds) {
      mergeBitsets(covered.get(threshold), candidateCoverage[bestIndex].get(threshold));
    }
    available.delete(bestIndex);
  }

  return {
    portfolio: selected,
    optimization: {
      method: "independent_monte_carlo_set_coverage_greedy_v1",
      trainingSampleCount,
      candidateCount: candidates.length + 1,
      thresholds,
    },
  };
}

export function evaluateCoveragePortfolio({
  portfolio,
  poolSize,
  pickCount,
  seed,
  evaluationSampleCount = 120000,
  thresholds = DEFAULT_THRESHOLDS,
}) {
  const lineMasks = portfolio.map((candidate) => numbersToMask(candidate.numbers ?? candidate));
  const lineCount = lineMasks.length;
  const drawMasks = generateDrawMasks(
    poolSize,
    pickCount,
    evaluationSampleCount,
    `${seed}:evaluation-draws`,
  );
  const hitCounts = new Map(thresholds.map((threshold) => [threshold, 0]));

  for (const drawMask of drawMasks) {
    let bestHits = 0;
    for (const lineMask of lineMasks) {
      bestHits = Math.max(bestHits, overlapCount(lineMask, drawMask));
    }
    for (const threshold of thresholds) {
      if (bestHits >= threshold) hitCounts.set(threshold, hitCounts.get(threshold) + 1);
    }
  }

  const metrics = Object.fromEntries(
    thresholds.map((threshold) => {
      const randomBaseline = exactRandomDistinctPortfolioProbability(
        poolSize,
        pickCount,
        threshold,
        lineCount,
      );
      const pairwiseDisjointEvents = lineCount > 1 && lineMasks.every((left, leftIndex) =>
        lineMasks.slice(leftIndex + 1).every(
          (right) => 2 * threshold - overlapCount(left, right) > pickCount,
        ),
      );
      const singleLineProbability = exactRandomDistinctPortfolioProbability(
        poolSize,
        pickCount,
        threshold,
        1,
      );
      const estimatedProbability = lineCount === 1
        ? randomBaseline
        : pairwiseDisjointEvents
          ? lineCount * singleLineProbability
          : hitCounts.get(threshold) / evaluationSampleCount;
      const standardError = lineCount === 1 || pairwiseDisjointEvents
        ? 0
        : Math.sqrt(
          (estimatedProbability * (1 - estimatedProbability)) / evaluationSampleCount,
        );
      return [
        threshold,
        {
          threshold,
          estimatedProbability,
          randomBaseline,
          liftPercentagePoints: (estimatedProbability - randomBaseline) * 100,
          relativeLiftPercent: randomBaseline > 0
            ? ((estimatedProbability / randomBaseline) - 1) * 100
            : 0,
          standardErrorPercentagePoints: standardError * 100,
          confidence95Low: Math.max(0, estimatedProbability - 1.96 * standardError),
          confidence95High: Math.min(1, estimatedProbability + 1.96 * standardError),
          method: lineCount === 1
            ? "exact_single_line_hypergeometric"
            : pairwiseDisjointEvents
              ? "exact_pairwise_disjoint_union"
              : "independent_monte_carlo_holdout_v1",
        },
      ];
    }),
  );

  return {
    method: lineCount === 1
      ? "exact_single_line_hypergeometric"
      : "independent_monte_carlo_holdout_v1",
    evaluationSampleCount: lineCount === 1 ? 0 : evaluationSampleCount,
    metrics,
  };
}
