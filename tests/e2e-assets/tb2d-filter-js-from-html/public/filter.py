import re
import sys
from pathlib import Path


def filter_html(content: str) -> str:
    """Intentionally incomplete starter that only removes ordinary script blocks."""
    return re.sub(r"<script\b[^>]*>.*?</script\s*>", "", content, flags=re.IGNORECASE | re.DOTALL)


def main() -> None:
    target = Path(sys.argv[1])
    target.write_text(filter_html(target.read_text(encoding="utf-8")), encoding="utf-8")


if __name__ == "__main__":
    main()

