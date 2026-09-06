import unittest
from src.browserless.cost import BudgetGovernor, luna_cost


class CostTest(unittest.TestCase):
    def test_luna_pricing_math(self):
        self.assertAlmostEqual(luna_cost(1_000_000, 0, 0), 0.20, places=6)
        self.assertAlmostEqual(luna_cost(1_000_000, 1_000_000, 0), 0.02, places=6)
        self.assertAlmostEqual(luna_cost(0, 0, 1_000_000), 1.20, places=6)

    def test_budget_blocks_before_hard_ceiling(self):
        result = BudgetGovernor(hard_budget_usd=0.001, max_output_tokens=4096).preflight(0.0, "hello")
        self.assertFalse(result["allowed"])
