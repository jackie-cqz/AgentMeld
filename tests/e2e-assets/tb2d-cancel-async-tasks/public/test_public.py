import asyncio
import unittest

from run import run_tasks


class PublicAsyncRunnerTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_results_in_input_order(self) -> None:
        def make(value: int, delay: float):
            async def worker() -> int:
                await asyncio.sleep(delay)
                return value
            return worker

        result = await run_tasks([make(1, 0.02), make(2, 0.0)], max_concurrent=2)
        self.assertEqual(result, [1, 2])

    async def test_rejects_invalid_inputs(self) -> None:
        with self.assertRaises(ValueError):
            await run_tasks([], max_concurrent=1)


if __name__ == "__main__":
    unittest.main()

