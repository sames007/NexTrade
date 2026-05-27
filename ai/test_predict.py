"""Unit tests for the educational one-session stock forecast helper."""

import math
import unittest

from ai.predict import forecast


def daily_history(count, daily_change=0.0, intraday_range=0.01):
    price = 100.0
    history = []
    for index in range(count):
        if index:
            price *= 1 + daily_change
        history.append(
            {
                "close": price,
                "high": price * (1 + intraday_range),
                "low": price * (1 - intraday_range),
                "volume": 1_000_000 + index * 100,
            }
        )
    return history


class ForecastTests(unittest.TestCase):
    def test_strong_consistent_trend_produces_bounded_up_estimate(self):
        history = daily_history(70, daily_change=0.02, intraday_range=0.002)
        current_price = history[-1]["close"]
        result = forecast({"history": history, "currentPrice": current_price})

        self.assertGreater(result["predictedPrice"], current_price)
        self.assertEqual(result["direction"], "up")
        self.assertGreater(result["validationPoints"], 20)
        self.assertLess(result["estimatedLow"], result["estimatedHigh"])
        self.assertTrue(math.isfinite(result["backtestMaePercent"]))

    def test_flat_history_retains_last_price_baseline(self):
        history = daily_history(60)
        result = forecast({"history": history, "currentPrice": 100.0})

        self.assertAlmostEqual(result["predictedPrice"], 100.0, places=4)
        self.assertEqual(result["direction"], "uncertain")
        baseline = next(metric for metric in result["modelMetrics"] if metric["model"] == "Last-price baseline")
        self.assertEqual(baseline["weightPercent"], 100.0)

    def test_current_quote_is_the_forecast_anchor(self):
        history = daily_history(40)
        result = forecast({"history": history, "currentPrice": 105.0})

        self.assertAlmostEqual(result["predictedPrice"], 105.0, places=4)
        self.assertLess(result["estimatedLow"], result["predictedPrice"])
        self.assertGreater(result["estimatedHigh"], result["predictedPrice"])

    def test_rejects_short_history(self):
        with self.assertRaises(ValueError):
            forecast({"history": daily_history(10), "currentPrice": 100.0})


if __name__ == "__main__":
    unittest.main()
