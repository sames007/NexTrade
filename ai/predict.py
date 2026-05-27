"""One-session stock estimate using provider-sourced daily price history.

This module is intentionally transparent rather than pretending historical
prices can reliably predict future returns. Candidate forecasts are evaluated
one step at a time using only earlier observations, and a last-price baseline
retains most or all of the weight unless another estimate improves historically.
"""

import json
import math
import sys
from typing import Any, Dict, List, Tuple

import numpy as np


MIN_OBSERVATIONS = 20
MAX_OBSERVATIONS = 120
MIN_TRAINING_POINTS = 15
MIN_WEIGHT_HISTORY = 8
BASELINE_MODEL = "last_price"
MODEL_LABELS = {
    BASELINE_MODEL: "Last-price baseline",
    "recent_drift": "Recent weighted drift",
    "trend_10": "10-session log trend",
    "trend_20": "20-session log trend",
}


def positive_float(value: Any) -> float:
    """Return a valid positive finite price, or NaN for unusable input."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return float("nan")
    return number if math.isfinite(number) and number > 0 else float("nan")


def normalize_payload(payload: Any) -> Tuple[List[Dict[str, float]], float]:
    """Normalize both the new OHLC payload and legacy arrays of close prices."""
    raw_history = payload.get("history", []) if isinstance(payload, dict) else payload
    requested_price = payload.get("currentPrice") if isinstance(payload, dict) else None

    if not isinstance(raw_history, list):
        raise ValueError("History must be a list")

    history = []
    for value in raw_history:
        if isinstance(value, dict):
            close = positive_float(value.get("close"))
            high = positive_float(value.get("high"))
            low = positive_float(value.get("low"))
            volume = positive_float(value.get("volume"))
        else:
            close = positive_float(value)
            high = close
            low = close
            volume = float("nan")

        if not math.isfinite(close):
            continue

        history.append(
            {
                "close": close,
                "high": high if math.isfinite(high) and high >= close else close,
                "low": low if math.isfinite(low) and low <= close else close,
                "volume": volume if math.isfinite(volume) else 0.0,
            }
        )

    history = history[-MAX_OBSERVATIONS:]
    if len(history) < MIN_OBSERVATIONS:
        raise ValueError(f"Need at least {MIN_OBSERVATIONS} usable daily observations")

    current_price = positive_float(requested_price)
    if not math.isfinite(current_price):
        current_price = history[-1]["close"]

    return history, current_price


def return_volatility(closes: np.ndarray) -> float:
    """Estimate close-to-close volatility robustly to reduce outlier influence."""
    returns = np.diff(np.log(closes))
    if len(returns) < 2:
        return 0.005

    median = float(np.median(returns))
    median_absolute_deviation = float(np.median(np.abs(returns - median)))
    robust_sigma = 1.4826 * median_absolute_deviation
    lower, upper = np.percentile(returns, [5, 95])
    winsorized_sigma = float(np.std(np.clip(returns, lower, upper), ddof=1))
    return max(robust_sigma, winsorized_sigma, 0.0025)


def daily_volatility(history: List[Dict[str, float]], closes: np.ndarray) -> float:
    """Blend close volatility with an OHLC range estimate for the displayed range."""
    close_sigma = return_volatility(closes)
    log_ranges = [
        math.log(point["high"] / point["low"])
        for point in history[-30:]
        if point["high"] >= point["low"] > 0
    ]

    if not log_ranges:
        return close_sigma

    # Parkinson's OHLC range estimate gives useful uncertainty information
    # without introducing an opaque machine-learning dependency.
    range_sigma = math.sqrt(float(np.mean(np.square(log_ranges))) / (4 * math.log(2)))
    return max(close_sigma, range_sigma, 0.0025)


def clipped_return(value: float, closes: np.ndarray) -> float:
    """Prevent a noisy short sample from generating implausible one-day jumps."""
    bound = max(0.005, min(0.10, 3 * return_volatility(closes)))
    return float(np.clip(value, -bound, bound))


def candidate_returns(closes: np.ndarray) -> Dict[str, float]:
    """Produce transparent candidate log-return forecasts for the next close."""
    log_closes = np.log(closes)
    returns = np.diff(log_closes)
    recent_returns = returns[-min(20, len(returns)) :]
    decay = np.exp(np.arange(len(recent_returns), dtype=float) / 6.0)
    recent_drift = float(np.average(recent_returns, weights=decay))

    candidates = {
        BASELINE_MODEL: 0.0,
        "recent_drift": clipped_return(recent_drift, closes),
    }

    for window, name in ((10, "trend_10"), (20, "trend_20")):
        window_closes = log_closes[-min(window, len(log_closes)) :]
        x_values = np.arange(len(window_closes), dtype=float)
        slope = float(np.polyfit(x_values, window_closes, 1)[0])
        candidates[name] = clipped_return(slope, closes)

    return candidates


def error_percent(predicted_return: float, actual_return: float) -> float:
    """Compare next-session percentage changes rather than dollar prices."""
    return abs(math.expm1(predicted_return) - math.expm1(actual_return)) * 100


def model_weights(errors: Dict[str, List[float]]) -> Dict[str, float]:
    """Give non-baseline models weight only after meaningful historical improvement."""
    baseline_errors = errors[BASELINE_MODEL]
    if len(baseline_errors) < MIN_WEIGHT_HISTORY:
        return {BASELINE_MODEL: 1.0}

    baseline_mae = float(np.mean(baseline_errors))
    if baseline_mae <= 1e-9:
        return {BASELINE_MODEL: 1.0}

    improvements = {}
    for name, values in errors.items():
        if name == BASELINE_MODEL or len(values) != len(baseline_errors):
            continue
        mae = float(np.mean(values))
        improvement = (baseline_mae - mae) / baseline_mae
        if improvement >= 0.03:
            improvements[name] = improvement

    if not improvements:
        return {BASELINE_MODEL: 1.0}

    model_budget = min(0.60, max(improvements.values()) * 2.0)
    total_improvement = sum(improvements.values())
    weights = {BASELINE_MODEL: 1.0 - model_budget}
    for name, improvement in improvements.items():
        weights[name] = model_budget * improvement / total_improvement
    return weights


def walk_forward_validation(closes: np.ndarray) -> Dict[str, Any]:
    """Evaluate one-session forecasts sequentially without using future values."""
    errors = {name: [] for name in MODEL_LABELS}
    ensemble_errors = []
    direction_results = []

    for target_index in range(MIN_TRAINING_POINTS, len(closes)):
        training_closes = closes[:target_index]
        candidates = candidate_returns(training_closes)
        weights = model_weights(errors)
        ensemble_return = sum(candidates[name] * weight for name, weight in weights.items())
        actual_return = math.log(closes[target_index] / closes[target_index - 1])

        ensemble_errors.append(error_percent(ensemble_return, actual_return))
        if abs(ensemble_return) > 1e-9 and abs(actual_return) > 1e-9:
            direction_results.append(math.copysign(1, ensemble_return) == math.copysign(1, actual_return))

        for name, predicted_return in candidates.items():
            errors[name].append(error_percent(predicted_return, actual_return))

    final_weights = model_weights(errors)
    model_metrics = []
    for name, values in errors.items():
        model_metrics.append(
            {
                "model": MODEL_LABELS[name],
                "weightPercent": round(final_weights.get(name, 0.0) * 100, 1),
                "maePercent": round(float(np.mean(values)), 3) if values else None,
            }
        )

    return {
        "weights": final_weights,
        "validationPoints": len(ensemble_errors),
        "backtestMaePercent": round(float(np.mean(ensemble_errors)), 3) if ensemble_errors else None,
        "baselineMaePercent": model_metrics[0]["maePercent"],
        "directionAccuracyPercent": (
            round(sum(direction_results) / len(direction_results) * 100, 1)
            if direction_results
            else None
        ),
        "modelMetrics": model_metrics,
    }


def forecast(payload: Any) -> Dict[str, Any]:
    """Build an educational next-trading-session estimate and diagnostic range."""
    history, current_price = normalize_payload(payload)
    closes = np.array([point["close"] for point in history], dtype=float)
    validation = walk_forward_validation(closes)
    candidates = candidate_returns(closes)
    weighted_return = sum(
        candidates[name] * weight for name, weight in validation["weights"].items()
    )

    predicted_price = current_price * math.exp(weighted_return)
    volatility = daily_volatility(history, closes)
    range_width = min(0.35, 1.645 * volatility)
    estimated_low = predicted_price * math.exp(-range_width)
    estimated_high = predicted_price * math.exp(range_width)
    percent_change = math.expm1(weighted_return) * 100
    uncertain_threshold = max(volatility * 0.35, 0.002)

    if abs(weighted_return) < uncertain_threshold:
        direction = "uncertain"
    else:
        direction = "up" if weighted_return > 0 else "down"

    baseline_mae = validation["baselineMaePercent"]
    forecast_mae = validation["backtestMaePercent"]
    if (
        validation["validationPoints"] >= 20
        and baseline_mae
        and forecast_mae is not None
        and forecast_mae < baseline_mae * 0.95
    ):
        reliability = "historically improved, still limited"
    else:
        reliability = "limited"

    return {
        "predictedPrice": round(predicted_price, 4),
        "estimatedLow": round(estimated_low, 4),
        "estimatedHigh": round(estimated_high, 4),
        "predictedChangePercent": round(percent_change, 3),
        "volatilityPercent": round(volatility * 100, 3),
        "direction": direction,
        "reliability": reliability,
        "method": "Walk-forward weighted ensemble with last-price baseline",
        "horizon": "Next trading session close",
        "validationPoints": validation["validationPoints"],
        "backtestMaePercent": validation["backtestMaePercent"],
        "baselineMaePercent": validation["baselineMaePercent"],
        "directionAccuracyPercent": validation["directionAccuracyPercent"],
        "modelMetrics": validation["modelMetrics"],
    }


def main() -> None:
    if len(sys.argv) != 2:
        raise ValueError("Usage: python predict.py '<forecast_input_json>'")
    payload = json.loads(sys.argv[1])
    print(json.dumps(forecast(payload), separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (json.JSONDecodeError, ValueError) as error:
        print(f"Invalid input: {error}", file=sys.stderr)
        sys.exit(1)
    except Exception as error:  # pragma: no cover - protects the Node subprocess boundary.
        print(f"Prediction failed: {error}", file=sys.stderr)
        sys.exit(1)
