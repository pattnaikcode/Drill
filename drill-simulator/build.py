"""Bundle the drill simulator into single HTML files.

    python3 build.py

Writes:
  dist/index.html             the drill simulator; open it in a browser or serve it with GitHub Pages
  dist/builder.html           the System Builder (forms that write blueprint YAML)
  dist/artifact.html, dist/builder-artifact.html
                              the same pages without the <html>/<head>/<body> wrapper (for hosts that add their own)

Blueprints (blueprints/*.yaml) and drills (drills/*.yaml) are embedded as text, so the
YAML files stay the single source of truth.
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).parent
DEFAULT_BLUEPRINT = "trade-allocation-kafka"  # the system the app opens with


def build(template: str = "src/index.template.html") -> str:
    page = (ROOT / template).read_text(encoding="utf-8")
    for rel in re.findall(r"/\*INLINE:([^*]+)\*/", page):
        code = (ROOT / rel).read_text(encoding="utf-8")
        page = page.replace(f"/*INLINE:{rel}*/", code.replace("</script", "<\\/script"))
    content = {
        "blueprints": {p.stem: p.read_text(encoding="utf-8") for p in sorted((ROOT / "blueprints").glob("*.yaml"))},
        "default_blueprint": DEFAULT_BLUEPRINT,
        "drills": [p.read_text(encoding="utf-8") for p in sorted((ROOT / "drills").glob("*.yaml"))],
    }
    js = "window.DRILL_CONTENT = " + json.dumps(content, ensure_ascii=False).replace("</", "<\\/") + ";"
    return page.replace("/*CONTENT*/", js)


def full_page(body: str) -> str:
    return ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            + body.replace("<header", "</head>\n<body>\n<header", 1) + "\n</body>\n</html>\n")


if __name__ == "__main__":
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    for template, name in [("src/index.template.html", "index"), ("src/builder.template.html", "builder")]:
        body = build(template)
        (dist / ("artifact.html" if name == "index" else f"{name}-artifact.html")).write_text(body, encoding="utf-8")
        page = full_page(body)
        (dist / f"{name}.html").write_text(page, encoding="utf-8")
        print(f"dist/{name}.html  {len(page) // 1024} KB")
