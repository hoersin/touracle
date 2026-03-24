from __future__ import annotations

from pathlib import Path

from tree_sitter import Language, Parser
import tree_sitter_javascript


def _first_error_node(root):
    stack = [root]
    while stack:
        n = stack.pop()
        if n.type == "ERROR":
            return n
        # Preorder traversal: push children in reverse order
        for c in reversed(n.children):
            if c.has_error or c.type == "ERROR":
                stack.append(c)
    return None


def main() -> None:
    parser = Parser()
    parser.language = Language(tree_sitter_javascript.language())

    files = [
        Path("project/frontend/map.js"),
        Path("project/frontend/profile.js"),
        Path("project/frontend/sidebar.js"),
        Path("project/frontend/profile_zoom.js"),
        Path("project/frontend/index.html"),
    ]

    for f in files:
        if not f.exists():
            print(f"{f}: MISSING")
            continue

        src = f.read_bytes()

        # For HTML, extract inline scripts very roughly.
        if f.suffix.lower() == ".html":
            text = src.decode("utf-8", errors="replace")
            chunks: list[tuple[str, str]] = []
            start = 0
            idx = 0
            while True:
                s = text.find("<script", start)
                if s < 0:
                    break
                e = text.find(">", s)
                if e < 0:
                    break
                close = text.find("</script>", e)
                if close < 0:
                    break
                code = text[e + 1 : close]
                idx += 1
                chunks.append((f"{f.name}::script[{idx}]", code))
                start = close + len("</script>")
            if not chunks:
                print(f"{f.name} OK (no inline scripts found)")
                continue

            for label, code in chunks:
                tree = parser.parse(code.encode("utf-8"))
                root = tree.root_node
                if not root.has_error:
                    continue
                err = _first_error_node(root)
                if not err:
                    print(f"{label}: HAS_ERROR")
                    continue
                (r0, c0) = err.start_point
                lines = code.splitlines()
                ctx = lines[r0].strip() if 0 <= r0 < len(lines) else ""
                print(f"{label}: ERROR at {r0+1}:{c0+1}: {ctx[:200]}")
            continue

        tree = parser.parse(src)
        root = tree.root_node
        if not root.has_error:
            print(f"{f.name} OK")
            continue

        err = _first_error_node(root)
        if not err:
            print(f"{f.name} HAS_ERROR")
            continue

        (r0, c0) = err.start_point
        lines = src.decode("utf-8", errors="replace").splitlines()
        ctx = lines[r0].strip() if 0 <= r0 < len(lines) else ""
        print(f"{f.name} ERROR at {r0+1}:{c0+1}: {ctx[:200]}")


if __name__ == "__main__":
    main()
