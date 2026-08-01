import asyncio
import unittest

from run import run_tasks


class HiddenAsyncRunnerTests(unittest.IsolatedAsyncioTestCase):
    async def test_enforces_peak_concurrency(self) -> None:
        active = 0
        peak = 0
        lock = asyncio.Lock()

        def make(value: int):
            async def worker() -> int:
                nonlocal active, peak
                async with lock:
                    active += 1
                    peak = max(peak, active)
                try:
                    await asyncio.sleep(0.02)
                    return value
                finally:
                    async with lock:
                        active -= 1
            return worker

        result = await run_tasks([make(index) for index in range(20)], max_concurrent=3)
        self.assertEqual(result, list(range(20)))
        self.assertLessEqual(peak, 3)

    async def test_cancellation_waits_for_started_cleanup(self) -> None:
        started: set[int] = set()
        cleaned: set[int] = set()
        gate = asyncio.Event()

        def make(index: int):
            async def worker() -> int:
                started.add(index)
                try:
                    await gate.wait()
                    return index
                finally:
                    await asyncio.sleep(0)
                    cleaned.add(index)
            return worker

        driver = asyncio.create_task(run_tasks([make(index) for index in range(8)], 2))
        for _ in range(50):
            if len(started) >= 2:
                break
            await asyncio.sleep(0.002)
        driver.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await driver
        self.assertEqual(cleaned, started)

        current = asyncio.current_task()
        leaked = [task for task in asyncio.all_tasks() if task is not current and not task.done()]
        self.assertEqual(leaked, [])


if __name__ == "__main__":
    unittest.main()

