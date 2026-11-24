"""Resident static demo server and the `publish` command (stdlib only).

serve   run the server (systemd keeps it up)
publish copy a folder or file to the server, print one verified URL, then the LAT board's
        address of the same page when the board is set
publish-md  render a Markdown file into the shared frame and publish it like `publish`

Settings come from env, then ~/.agents/demo.json: port, host (public name), data (dir), bind,
board (the LAT board's URL, which serves <data>/site behind its login at /demo/<name>/).
The URL key lives in <data>/.key and is created on first use.
"""
import hmac
import html
import json
import os
import re
import secrets
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from functools import partial
from http import cookies
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_AGE = 14 * 86400
NAME_RE = re.compile(r'^[a-z0-9][a-z0-9._-]{0,63}$')
VIEWER_MARK = '<!--demo-viewer-->'
FULL_DOC = re.compile(r'\s*(<!doctype|<html)', re.I)

FRAME = '''<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
:root{--bg:#fafafa;--fg:#1c1c1e;--card:#fff;--line:#d8d8dc;--accent:#2563eb;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--bg:#161618;--fg:#ececf0;--card:#222226;--line:#3a3a40;--accent:#7aa2ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:18px/1.6 system-ui,-apple-system,"Noto Sans TC",sans-serif}
main{max-width:1280px;margin:0 auto;padding:16px}
:is(main,[data-variant])>:is(p,h1,h2,h3,h4,ul,ol,blockquote){max-width:860px}
img,video,table,pre{max-width:100%}pre,table{overflow-x:auto;display:block}
.card,.option{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:12px 0}
.options{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr))}
.options .option{margin:0}
#variants{position:sticky;top:0;z-index:10;display:flex;gap:8px;flex-wrap:wrap;padding:8px 16px;background:var(--bg);border-bottom:1px solid var(--line)}
#variants button{font:inherit;padding:6px 14px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--fg)}
#variants button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}
[data-variant][hidden]{display:none}
</style></head><body>
<nav id="variants" hidden></nav>
<main>
__BODY__
</main>
<script>
const v=[...document.querySelectorAll('[data-variant]')],nav=document.getElementById('variants');
if(v.length>1){nav.hidden=false;const pick=n=>{v.forEach(e=>e.hidden=e.dataset.variant!==n);
nav.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.n===n));history.replaceState(null,'','#'+n)};
v.forEach(e=>{const b=document.createElement('button');b.dataset.n=e.dataset.variant;b.textContent=e.dataset.title||e.dataset.variant;
b.onclick=()=>pick(e.dataset.variant);nav.append(b)});pick(location.hash.slice(1)||v[0].dataset.variant)}
</script></body></html>
'''


MD_CSS = """<style>
.md>:is(p,h1,h2,h3,h4,ul,ol,blockquote){max-width:860px}
.md h1,.md h2,.md h3,.md h4{line-height:1.3;margin:1.2em 0 .5em}
.md p,.md ul,.md ol,.md blockquote{margin:.6em 0}
.md code{font:1em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:0 .3em}
.md pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:.8em 0}
.md pre code{border:0;padding:0;background:none}
.md blockquote{border-left:4px solid var(--line);padding-left:16px;margin-left:0;opacity:.85}
.md hr{border:0;border-top:1px solid var(--line);margin:1.5em 0}
.md a{color:var(--accent)}
.md .tbl{overflow-x:auto;max-width:100%;margin:.8em 0}
.md .tbl table{display:table;border-collapse:collapse;width:max-content;min-width:100%;max-width:none;overflow:visible}
.md th,.md td{border:1px solid var(--line);padding:6px 12px;text-align:left;vertical-align:top}
.md th{background:var(--card)}
.md td{min-width:5em;max-width:30em}
</style>"""

SAFE_URL = re.compile(r'^(https?://|mailto:|#|/|\./|\.\./|[\w.~%-]+(/|$))', re.I)
FENCE = re.compile(r'^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)')
HEADING = re.compile(r'^\s{0,3}(#{1,6})\s+(.*)$')
HRULE = re.compile(r'^\s{0,3}([-*_])(\s*\1){2,}\s*$')
LIST_ITEM = re.compile(r'^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$')
TABLE_SEP = re.compile(r'^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$')


def heading_text(text):
    """A heading's text without its optional closing run of # (which needs a space before it)."""
    text = text.rstrip()
    stripped = text.rstrip('#')
    return stripped.rstrip() if stripped != text and (not stripped or stripped[-1] == ' ') else text


def md_inline(text):
    """Inline Markdown to HTML. Everything is escaped first; only tags built here reach the page."""
    spans = []
    def stash(m):
        spans.append(f'<code>{html.escape(m.group(2).strip(), quote=False)}</code>')
        return f'\x00{len(spans) - 1}\x00'
    text = re.sub(r'(`+)(.+?)\1', stash, text.replace('\x00', ''))
    text = html.escape(text, quote=True)
    def link(m):
        url = html.unescape(m.group(2).strip())
        if '\x00' in url or not SAFE_URL.match(url) or re.match(r'^\s*(javascript|data|vbscript):', url, re.I):
            return m.group(0)
        spans.append(f'<a href="{html.escape(url)}" rel="noopener noreferrer">{m.group(1)}</a>')
        return f'\x00{len(spans) - 1}\x00'
    text = re.sub(r'\[([^\]\n]+)\]\(([^)\s]+)\)', link, text)
    text = re.sub(r'\*\*(.+?)\*\*|__(.+?)__', lambda m: f'<strong>{m.group(1) or m.group(2)}</strong>', text)
    text = re.sub(r'(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])', r'<em>\1</em>', text)
    text = re.sub(r'~~(.+?)~~', r'<del>\1</del>', text)
    while '\x00' in text:
        text = re.sub(r'\x00(\d+)\x00', lambda m: spans[int(m.group(1))], text)
    return text


def _cells(line):
    line = line.strip()
    if line.startswith('|'):
        line = line[1:]
    if line.endswith('|') and not line.endswith('\\|'):
        line = line[:-1]
    return [c.strip().replace('\\|', '|') for c in re.split(r'(?<!\\)\|', line)]


def _table(head, sep, rows):
    aligns = []
    for c in _cells(sep):
        aligns.append('center' if c.startswith(':') and c.endswith(':') else 'right' if c.endswith(':') else '')
    def cell(tag, i, text):
        a = aligns[i] if i < len(aligns) and aligns[i] else ''
        style = f' style="text-align:{a}"' if a else ''
        return f'<{tag}{style}>{md_inline(text)}</{tag}>'
    out = ['<div class="tbl" tabindex="0"><table><thead><tr>']
    out += [cell('th', i, c) for i, c in enumerate(_cells(head))]
    out.append('</tr></thead><tbody>')
    for r in rows:
        out.append('<tr>' + ''.join(cell('td', i, c) for i, c in enumerate(_cells(r))) + '</tr>')
    out.append('</tbody></table></div>')
    return ''.join(out)


def _list(lines, i):
    """Render the list starting at lines[i]; return (html, next index). Nesting follows indentation."""
    m = LIST_ITEM.match(lines[i])
    base = len(m.group(1).expandtabs(4))
    tag = 'ol' if m.group(2)[0].isdigit() else 'ul'
    out = [f'<{tag}>']
    while i < len(lines):
        m = LIST_ITEM.match(lines[i])
        if not m:
            break
        indent = len(m.group(1).expandtabs(4))
        if indent < base:
            break
        if indent > base:
            sub, i = _list(lines, i)
            if out[-1].endswith('</li>'):
                out[-1] = out[-1][:-5] + sub + '</li>'
            else:
                out.append(sub)
            continue
        if ('ol' if m.group(2)[0].isdigit() else 'ul') != tag:
            break
        body = m.group(3)
        box = re.match(r'^\[([ xX])\]\s+(.*)$', body)
        if box:
            body = ('☑ ' if box.group(1) != ' ' else '☐ ') + box.group(2)
        out.append(f'<li>{md_inline(body)}</li>')
        i += 1
    out.append(f'</{tag}>')
    return ''.join(out), i


def md_to_html(source):
    """Render Markdown (headings, paragraphs, lists, tables, fenced code, quotes, rules) to an HTML
    fragment inside <div class="md">. Source text is escaped; raw HTML in it is shown as text."""
    lines = source.lstrip('﻿').replace('\r\n', '\n').replace('\r', '\n').split('\n')
    out, i, para = [], 0, []
    def flush():
        if para:
            out.append('<p>' + '<br>'.join(md_inline(p.strip()) for p in para) + '</p>')
            para.clear()
    while i < len(lines):
        line = lines[i]
        fence = FENCE.match(line)
        if fence:
            flush()
            mark, lang = fence.group(1), fence.group(2)
            i += 1
            code = []
            while i < len(lines) and not (lines[i].strip().startswith(mark[0] * len(mark))
                                          and not lines[i].strip().strip(mark[0])):
                code.append(lines[i])
                i += 1
            i += 1
            cls = f' class="language-{html.escape(lang)}"' if lang else ''
            out.append(f'<pre><code{cls}>{html.escape(chr(10).join(code), quote=False)}</code></pre>')
        elif not line.strip():
            flush()
            i += 1
        elif HEADING.match(line):
            flush()
            m = HEADING.match(line)
            n = len(m.group(1))
            heading = heading_text(m.group(2))
            out.append(f'<h{n}>{md_inline(heading)}</h{n}>')
            i += 1
        elif HRULE.match(line):
            flush()
            out.append('<hr>')
            i += 1
        elif '|' in line and i + 1 < len(lines) and '|' in lines[i + 1] and TABLE_SEP.match(lines[i + 1]) and '-' in lines[i + 1]:
            flush()
            head, sep = line, lines[i + 1]
            i += 2
            rows = []
            while i < len(lines) and lines[i].strip() and '|' in lines[i]:
                rows.append(lines[i])
                i += 1
            out.append(_table(head, sep, rows))
        elif line.lstrip().startswith('>'):
            flush()
            quote = []
            while i < len(lines) and lines[i].lstrip().startswith('>'):
                quote.append(re.sub(r'^\s*>\s?', '', lines[i]))
                i += 1
            out.append('<blockquote>' + md_to_html('\n'.join(quote)).removeprefix('<div class="md">').removesuffix('</div>') + '</blockquote>')
        elif LIST_ITEM.match(line):
            flush()
            block, i = _list(lines, i)
            out.append(block)
        else:
            para.append(line)
            i += 1
    flush()
    return '<div class="md">' + ''.join(out) + '</div>'


def md_title(source, fallback):
    """The first top-level heading outside fenced code, as plain text."""
    lines = source.splitlines()
    i = 0
    while i < len(lines):
        f = FENCE.match(lines[i])
        if f:
            mark = f.group(1)
            i += 1
            while i < len(lines) and not (lines[i].strip().startswith(mark[0] * len(mark)) and not lines[i].strip().strip(mark[0])):
                i += 1
        else:
            m = HEADING.match(lines[i])
            if m and len(m.group(1)) == 1:
                return re.sub(r'[`*_]', '', heading_text(m.group(2))) or fallback
        i += 1
    return fallback


def md_page(source):
    """The fragment publish-md hands to the shared frame: styles, then the rendered report."""
    return MD_CSS + md_to_html(source)


def settings():
    conf = {}
    path = Path(os.environ.get('DEMO_CONFIG', Path.home() / '.agents/demo.json'))
    if path.is_file():
        conf = json.loads(path.read_text())
    def pick(env, key, default=None):
        return os.environ.get(env) or conf.get(key) or default
    port = pick('DEMO_PORT', 'port')
    if not port:
        raise SystemExit('demo: no port; set DEMO_PORT or "port" in ~/.agents/demo.json (see ~/.agents/lat-private.md)')
    data = Path(pick('DEMO_DATA', 'data', Path.home() / '.local/share/demo-publish'))
    host = pick('DEMO_HOST', 'host')
    if not host:
        raise SystemExit('demo: no host; set DEMO_HOST or "host" in ~/.agents/demo.json (see ~/.agents/lat-private.md)')
    return {'port': int(port), 'host': host,
            'bind': pick('DEMO_BIND', 'bind', '0.0.0.0'), 'data': data,
            'board': pick('DEMO_BOARD', 'board')}


def get_key(data):
    data.mkdir(parents=True, exist_ok=True)
    kf = data / '.key'
    if not kf.exists():
        fd = os.open(kf, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(secrets.token_urlsafe(18))
    return kf.read_text().strip()


def cleanup(site, now=None):
    now = time.time() if now is None else now
    removed = []
    for d in site.iterdir() if site.is_dir() else []:
        if d.is_dir() and now - d.stat().st_mtime > MAX_AGE:
            shutil.rmtree(d, ignore_errors=True)
            removed.append(d.name)
    return removed


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, key, **kw):
        self.key = key
        super().__init__(*a, **kw)

    def _authorised(self):
        url = urllib.parse.urlsplit(self.path)
        sent = urllib.parse.parse_qs(url.query).get('k', [''])[0]
        jar = cookies.SimpleCookie(self.headers.get('Cookie', ''))
        sent_cookie = jar['demo_key'].value if 'demo_key' in jar else ''
        for s in (sent, sent_cookie):
            if s and hmac.compare_digest(s.encode(), self.key.encode()):
                return url, bool(sent)
        return url, None

    def do_GET(self):
        url, via_query = self._authorised()
        if via_query is None:
            self.send_error(403, 'key required')
            return
        if url.path.rstrip('/') == '' or self.translate_path(url.path) == self.directory:
            self.send_error(404)
            return
        self.path = url.path
        self._set_cookie = via_query
        super().do_GET()

    do_HEAD = do_GET

    def end_headers(self):
        if getattr(self, '_set_cookie', False):
            self.send_header('Set-Cookie', f'demo_key={self.key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'no-referrer')
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)

    def log_message(self, *a):
        pass


def make_server(conf, key):
    site = conf['data'] / 'site'
    site.mkdir(parents=True, exist_ok=True)
    return ThreadingHTTPServer((conf['bind'], conf['port']), partial(Handler, key=key, directory=str(site)))


def serve():
    conf = settings()
    key = get_key(conf['data'])
    site = conf['data'] / 'site'
    srv = make_server(conf, key)
    def sweep():
        while True:
            cleanup(site)
            time.sleep(3600)
    threading.Thread(target=sweep, daemon=True).start()
    srv.serve_forever()


def viewer_snippet():
    js = (Path(__file__).resolve().parent / 'viewer.js').read_text(encoding='utf-8')
    return (f'{VIEWER_MARK}<style>:where(img){{cursor:zoom-in}}:where(a img,button img,label img,[data-no-zoom] img)'
            f'{{cursor:auto}}</style><script>{js}</script>')


def add_viewer(html):
    """Add the click-to-zoom image viewer once, just before the last </body> (or at the end)."""
    if VIEWER_MARK in html:
        return html
    at = html.lower().rfind('</body>')
    snippet = viewer_snippet()
    return html + snippet if at < 0 else html[:at] + snippet + html[at:]


def build_index(text, title):
    if FULL_DOC.match(text.lstrip('\ufeff')):
        return add_viewer(text)
    return add_viewer(FRAME.replace('__TITLE__', html.escape(title)).replace('__BODY__', text))


def publish(src, name, title=None):
    conf = settings()
    key = get_key(conf['data'])
    src = Path(src)
    if not NAME_RE.match(name):
        raise SystemExit('demo: --name must be lowercase letters, digits, . _ - (max 64)')
    if not src.exists():
        raise SystemExit(f'demo: {src} does not exist')
    site = conf['data'] / 'site'
    site.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(dir=conf['data'], prefix='.new-'))
    try:
        if src.is_dir():
            shutil.copytree(src, tmp, dirs_exist_ok=True, ignore_dangling_symlinks=True)
        else:
            shutil.copy2(src, tmp / 'index.html')
        index = tmp / 'index.html'
        if not index.is_file():
            raise SystemExit('demo: no index.html in the published folder')
        index.write_text(build_index(index.read_text(encoding='utf-8'), title or name), encoding='utf-8')
        dest = site / name
        old = conf['data'] / f'.old-{name}-{os.getpid()}'
        if dest.exists():
            dest.rename(old)
        tmp.rename(dest)
        tmp = None
        shutil.rmtree(old, ignore_errors=True)
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
    os.utime(dest)
    url = f'http://{conf["host"]}:{conf["port"]}/{name}/?k={key}'
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            if r.status != 200:
                raise SystemExit(f'demo: published but the URL answered {r.status}')
    except (urllib.error.URLError, OSError) as e:
        raise SystemExit(f'demo: published but the URL cannot be opened ({e}); is the server running?')
    print(url)
    if conf['board']:
        print(f'{conf["board"].rstrip("/")}/demo/{name}/')


def publish_md(src, name):
    src = Path(src)
    if not src.is_file():
        raise SystemExit(f'demo: {src} does not exist')
    text = src.read_text(encoding='utf-8')
    with tempfile.TemporaryDirectory(prefix='demo-md-') as d:
        (Path(d) / 'index.html').write_text(md_page(text), encoding='utf-8')
        publish(d, name, md_title(text, name))


def main(argv):
    if argv[:1] == ['serve']:
        return serve()
    if argv[:1] == ['publish'] and len(argv) >= 4 and argv[2] == '--name':
        return publish(argv[1], argv[3])
    if argv[:1] == ['publish-md'] and len(argv) == 4 and argv[2] == '--name':
        return publish_md(argv[1], argv[3])
    raise SystemExit('usage: demo.py serve | demo.py publish <folder|file> --name <name> '
                     '| demo.py publish-md <file.md> --name <name>')


if __name__ == '__main__':
    main(sys.argv[1:])
