from collections.abc import Callable
from datetime import datetime, timezone
from typing import TypeVar


def time_now() -> datetime:
    return datetime.now(tz=timezone.utc)


T = TypeVar("T")


def partition(iterable: list[T], pred: Callable[[T], bool]) -> tuple[list[T], list[T]]:
    trues = []
    falses = []

    for item in iterable:
        if pred(item):
            trues.append(item)
        else:
            falses.append(item)

    return trues, falses
