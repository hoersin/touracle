#!/usr/bin/env python3
"""Generate a PNG flowchart for STRATEGIC_AGGREGATION.md without Mermaid/Node.

This exists because the dev environment may not have access to mermaid-cli (Node)
or network-based Mermaid renderers.

Output:
  assets/docs/strategic_aggregation_flowchart.png
"""

from __future__ import annotations

import os
import textwrap
from dataclasses import dataclass

from PIL import Image, ImageDraw, ImageFont


@dataclass(frozen=True)
class Node:
    key: str
    text: str


NODES: list[Node] = [
    Node(
        "UI",
        "Frontend UI\nYears + Mode + Timescale/Range",
    ),
    Node(
        "REQ",
        "GET /api/strategic_grid\nyears, mode, time, bbox,\nlucky thresholds",
    ),
    Node(
        "STORES",
        "Resolve offline stores\none SQLite DB per year",
    ),
    Node(
        "DAYS",
        "Compute set of (month,day)\nfrom timescale or range",
    ),
    Node(
        "SQL",
        "SQL: tiles in bbox\nLEFT JOIN climatology\nfiltered by (month,day)",
    ),
    Node(
        "ACC",
        "Accumulate per tile:\n- medians for temps\n- means for numeric fields\n- threshold P(rain)\n- circular mean wind dir\n- lucky counts",
    ),
    Node(
        "RESP",
        "JSON response\npoints + sample_days + metadata",
    ),
    Node(
        "RENDER",
        "Frontend render\nselects fields by Mode,\ninterpolates + bins,\nshows tooltip/legend",
    ),
]


def _wrap_lines(text: str, width: int) -> list[str]:
    lines: list[str] = []
    for raw_line in text.splitlines():
        raw_line = raw_line.rstrip()
        if not raw_line:
            lines.append("")
            continue
        wrapped = textwrap.wrap(raw_line, width=width, break_long_words=False)
        lines.extend(wrapped if wrapped else [raw_line])
    return lines


def _arrow(draw: ImageDraw.ImageDraw, x0: int, y0: int, x1: int, y1: int) -> None:
    draw.line((x0, y0, x1, y1), fill=(0, 0, 0), width=3)
    # arrowhead
    ah = 10
    draw.polygon(
        [
            (x1, y1),
            (x1 - ah, y1 - ah),
            (x1 + ah, y1 - ah),
        ],
        fill=(0, 0, 0),
    )


def render(out_path: str) -> None:
    font = ImageFont.load_default()

    canvas_w = 1200
    box_w = 980
    margin_x = (canvas_w - box_w) // 2
    padding_x = 18
    padding_y = 14

    wrap_chars = 52

    node_lines: list[list[str]] = [_wrap_lines(n.text, width=wrap_chars) for n in NODES]
    line_h = font.getbbox("Ag")[3] + 6

    box_heights: list[int] = [padding_y * 2 + line_h * len(lines) for lines in node_lines]

    gap_y = 36
    top_margin = 40
    bottom_margin = 40

    total_h = top_margin + bottom_margin + sum(box_heights) + gap_y * (len(NODES) - 1)

    img = Image.new("RGB", (canvas_w, total_h), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)

    y = top_margin
    centers: list[tuple[int, int, int]] = []  # (box_top, box_bottom, center_x)

    for idx, (node, lines, h) in enumerate(zip(NODES, node_lines, box_heights, strict=True)):
        x0 = margin_x
        y0 = y
        x1 = margin_x + box_w
        y1 = y + h

        draw.rounded_rectangle((x0, y0, x1, y1), radius=18, outline=(0, 0, 0), width=3, fill=(255, 255, 255))

        # Draw text
        tx = x0 + padding_x
        ty = y0 + padding_y
        for line in lines:
            draw.text((tx, ty), line, fill=(0, 0, 0), font=font)
            ty += line_h

        centers.append((y0, y1, (x0 + x1) // 2))

        y = y1 + gap_y

    # Arrows between boxes
    for (top0, bot0, cx0), (top1, bot1, cx1) in zip(centers, centers[1:], strict=False):
        _arrow(draw, cx0, bot0 + 4, cx1, top1 - 6)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    img.save(out_path, format="PNG")


if __name__ == "__main__":
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    out_file = os.path.join(repo_root, "assets", "docs", "strategic_aggregation_flowchart.png")
    render(out_file)
    print(f"Wrote {out_file}")
