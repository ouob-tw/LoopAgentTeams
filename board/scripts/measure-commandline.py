# Measures the command line in WebKit, the same cases and rules as measure-commandline.ts.
#
#   bun scripts/measure-commandline.ts --serve        prints the address and the cookie
#   uv run --no-project --with playwright python scripts/measure-commandline.py <address> <cookie>
#
# Needs WebKit once: uv run --no-project --with playwright python -m playwright install webkit
import sys
from playwright.sync_api import sync_playwright

url, cookie = sys.argv[1], sys.argv[2]
name, value = cookie.split("=", 1)
TOL = 2
MEASURE = """() => {
  const form = document.querySelector('form.cmd');
  const centre = (n) => { const r = document.createRange(); r.selectNodeContents(n); const b = r.getBoundingClientRect(); return (b.top + b.bottom) / 2; };
  const rect = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
  const box = form.querySelector('textarea'), b = box.getBoundingClientRect(), cs = getComputedStyle(box);
  // The box's own text (placeholder when empty), laid out in a hidden copy of the box.
  const mirror = document.createElement('div');
  for (const k of ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','paddingTop','paddingBottom','paddingLeft','paddingRight','borderTopWidth','borderBottomWidth','borderLeftWidth','borderRightWidth']) mirror.style[k] = cs[k];
  mirror.style.cssText += ';position:fixed;visibility:hidden;white-space:pre-wrap;box-sizing:border-box;border-style:solid;border-color:transparent;width:' + b.width + 'px;left:' + b.left + 'px;top:' + b.top + 'px';
  mirror.textContent = box.value || box.placeholder;
  document.body.append(mirror);
  const text = centre(mirror);
  mirror.remove();
  return { label: centre(form.querySelector('.to')), box: text, button: centre(form.querySelector('button.send')),
    labelRect: rect(form.querySelector('.to')), boxRect: rect(box), buttonRect: rect(form.querySelector('button.send')),
    last: b.bottom - 1 - parseFloat(cs.paddingBottom) - parseFloat(cs.lineHeight) / 2,
    textRight: b.right - parseFloat(cs.paddingRight) };
}"""
overlap = lambda a, b: a["left"] < b["right"] and b["left"] < a["right"] and a["top"] < b["bottom"] and b["top"] < a["bottom"]
failures = []
with sync_playwright() as p:
    browser = p.webkit.launch()
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    ctx.add_cookies([{"name": name, "value": value, "url": url}])
    page = ctx.new_page()
    print("theme  size  case       label    box      button")
    for theme in ("dark", "light"):
        for scale in (80, 100, 150):
            page.goto(url)
            page.evaluate(f"localStorage.setItem('lat-board-theme','{theme}');localStorage.setItem('lat-board-scale','{scale}')")
            page.goto(url)
            page.wait_for_selector("form.cmd textarea")
            page.wait_for_timeout(500)
            single = None
            for case, text in (("hint", ""), ("one line", "一行指令"), ("four lines", "a\nb\nc\nd")):
                page.fill("form.cmd textarea", text)
                page.wait_for_timeout(150)
                m = page.evaluate(MEASURE)
                print(f"{theme:6} {scale:3}%  {case:10} {m['label']:7.1f} {m['box']:8.1f} {m['button']:8.1f}")
                tag = f"{theme} {scale}% {case}"
                if case != "four lines":
                    single = m
                    spread = max(m["label"], m["box"], m["button"]) - min(m["label"], m["box"], m["button"])
                    if spread > TOL:
                        failures.append(f"{tag}: centres differ by {spread:.1f}px")
                else:
                    for what in ("label", "button"):
                        rect, before = m[what + "Rect"], single[what + "Rect"]
                        if abs(m[what] - m["last"]) > TOL:
                            failures.append(f"{tag}: {what} is {m[what] - m['last']:.1f}px from the last line")
                        moved = (single["boxRect"]["bottom"] - before["bottom"]) - (m["boxRect"]["bottom"] - rect["bottom"])
                        if abs(moved) > TOL:
                            failures.append(f"{tag}: {what} moved {moved:.1f}px relative to the box's bottom edge")
                        box = m["boxRect"]
                        if what == "label" and overlap(rect, box):
                            failures.append(f"{tag}: label overlaps the box")
                        if what == "button":
                            if not (rect["left"] >= box["left"] and rect["right"] <= box["right"] and rect["top"] >= box["top"] and rect["bottom"] <= box["bottom"]):
                                failures.append(f"{tag}: button is not inside the box")
                            if m["textRight"] > rect["left"]:
                                failures.append(f"{tag}: the box's text runs under the button")
                    if m["boxRect"]["bottom"] - m["boxRect"]["top"] <= single["boxRect"]["bottom"] - single["boxRect"]["top"]:
                        failures.append(f"{tag}: the box did not grow")
    browser.close()
if failures:
    print("\n".join(failures))
    sys.exit(1)
print("all cases within the rules")
