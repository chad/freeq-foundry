#!/usr/bin/env python3
"""Verify that every Markdown link into the specification resolves to a heading.

The specification is the normative document and the ADRs, README, and issue
bodies all cite it by section anchor. A dead anchor turns a citation into a
decoration, and the whole point of citing is that a reader can check.
"""

from __future__ import annotations

import os
import re
import sys

SPEC_PATH = os.path.join("docs", "specification.md")


def slugify(heading: str) -> str:
    """Reproduce GitHub's heading-anchor algorithm closely enough."""
    text = heading.strip().lower()
    text = re.sub(r"[^\w\s-]", "", text)
    return re.sub(r"\s+", "-", text)


def main() -> int:
    if not os.path.exists(SPEC_PATH):
        print(f"missing {SPEC_PATH}", file=sys.stderr)
        return 1

    with open(SPEC_PATH, encoding="utf-8") as handle:
        spec = handle.read()

    anchors = {
        slugify(match.group(2))
        for match in re.finditer(r"^(#{1,6})\s+(.*)$", spec, re.MULTILINE)
    }

    pattern = re.compile(r"\]\(([^)]*specification\.md)#([^)\s]+)\)")
    failures: list[str] = []
    checked = 0

    for root, dirs, files in os.walk("."):
        dirs[:] = [d for d in dirs if d not in {".git", "node_modules", "dist"}]
        for name in files:
            if not name.endswith(".md"):
                continue
            path = os.path.join(root, name)
            with open(path, encoding="utf-8") as handle:
                content = handle.read()
            for match in pattern.finditer(content):
                checked += 1
                if match.group(2) not in anchors:
                    failures.append(f"{path}: #{match.group(2)}")

    for failure in failures:
        print(f"dead spec anchor -> {failure}", file=sys.stderr)

    print(f"checked {checked} specification links, {len(failures)} dead")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
