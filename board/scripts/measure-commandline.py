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
  const box = form.querySelector('textarea'), b = box.getBoundingClientRect(), cs = getComputedStyle(box);
  return { label: centre(form.querySelector('.to')), box: (b.top + b.bottom) / 2, button: centre(form.querySelector('button')),
    boxTop: b.top, boxBottom: b.bottom,
    last: b.bottom - 1 - parseFloat(cs.paddingBottom) - parseFloat(cs.lineHeight) / 2 };
}"""
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
            single_h = None
            for case, text in (("hint", ""), ("one line", "一行指令"), ("four lines", "a\nb\nc\nd")):
                page.fill("form.cmd textarea", text)
                page.wait_for_timeout(150)
                m = page.evaluate(MEASURE)
                print(f"{theme:6} {scale:3}%  {case:10} {m['label']:7.1f} {m['box']:8.1f} {m['button']:8.1f}")
                tag = f"{theme} {scale}% {case}"
                if case != "four lines":
                    single_h = m["boxBottom"] - m["boxTop"]
                    spread = max(m["label"], m["box"], m["button"]) - min(m["label"], m["box"], m["button"])
                    if spread > TOL:
                        failures.append(f"{tag}: centres differ by {spread:.1f}px")
                else:
                    for what in ("label", "button"):
                        if abs(m[what] - m["last"]) > TOL:
                            failures.append(f"{tag}: {what} is {m[what] - m['last']:.1f}px from the last line")
                    if m["boxBottom"] - m["boxTop"] <= single_h:
                        failures.append(f"{tag}: the box did not grow")
    browser.close()
if failures:
    print("\n".join(failures))
    sys.exit(1)
print("all cases within the rules")
