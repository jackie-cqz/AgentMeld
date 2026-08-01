import asyncio
from collections.abc import Awaitable, Callable, Sequence
from typing import TypeVar


T = TypeVar("T")
TaskFactory = Callable[[], Awaitable[T]]


async def run_tasks(tasks: Sequence[TaskFactory[T]], max_concurrent: int) -> list[T]:
    """Starter implementation: it passes the happy path but ignores the concurrency contract."""
    if not tasks:
        raise ValueError("tasks must not be empty")
    if max_concurrent <= 0:
        raise ValueError("max_concurrent must be positive")
    return list(await asyncio.gather(*(factory() for factory in tasks)))

