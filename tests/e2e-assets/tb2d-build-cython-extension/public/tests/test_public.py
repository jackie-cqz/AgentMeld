import unittest

from agentmeld_faststats import mean64


class PublicFastStatsTests(unittest.TestCase):
    def test_mean(self) -> None:
        self.assertAlmostEqual(mean64([1.0, 2.0, 6.0]), 3.0)

    def test_empty_input(self) -> None:
        with self.assertRaises(ValueError):
            mean64([])


if __name__ == "__main__":
    unittest.main()

