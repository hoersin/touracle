import os
import re
import sys
import urllib.request
import urllib.error


def main() -> int:
    md_path = os.path.join("project", "STRATEGIC_AGGREGATION.md")
    with open(md_path, "r", encoding="utf-8") as f:
        md = f.read()

    m = re.search(r"```mermaid\n(.*?)\n```", md, flags=re.S)
    if not m:
        print(f"No mermaid block found in {md_path}", file=sys.stderr)
        return 2

    code = m.group(1).strip() + "\n"

    out_path = os.path.join("assets", "docs", "strategic_aggregation_flowchart.png")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    # Use Kroki POST API: send Mermaid text, receive PNG bytes.
    # https://kroki.io/#how-does-it-work
    try:
        req = urllib.request.Request(
            "https://kroki.io/mermaid/png",
            data=code.encode("utf-8"),
            headers={
                "User-Agent": "WeatherMap-docgen",
                "Content-Type": "text/plain; charset=utf-8",
                "Accept": "image/png",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = resp.read()
        if not data or len(data) < 1000:
            raise RuntimeError(f"Suspiciously small response: {len(data)} bytes")
        with open(out_path, "wb") as f:
            f.write(data)
        print(f"Rendered {len(data)} bytes -> {out_path}")
        return 0
    except urllib.error.HTTPError as e:
        try:
            details = e.read().decode("utf-8", errors="replace")
        except Exception:
            details = ""
        msg = f"HTTP Error {getattr(e, 'code', '?')}: {e}"
        if details.strip():
            msg += "\n" + details.strip()
        print(f"Failed to render diagram: {msg}", file=sys.stderr)
        return 1
    except Exception as e:  # noqa: BLE001
        print(f"Failed to render diagram: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
