"""Resident static demo server and the `publish` command (stdlib only).

serve   run the server (systemd keeps it up)
publish copy a folder or file to the server, print one verified URL

Settings come from env, then ~/.agents/demo.json: port, host (public name), data (dir), bind.
The URL key lives in <data>/.key and is created on first use.
"""
import hmac
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
FULL_DOC = re.compile(r'\s*(<!doctype|<html)', re.I)

FRAME = '''<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
:root{--bg:#fafafa;--fg:#1c1c1e;--card:#fff;--line:#d8d8dc;--accent:#2563eb;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--bg:#161618;--fg:#ececf0;--card:#222226;--line:#3a3a40;--accent:#7aa2ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Noto Sans TC",sans-serif}
main{max-width:1280px;margin:0 auto;padding:16px}
main>:is(p,h1,h2,h3,h4,ul,ol,blockquote){max-width:860px}
img,video,table,pre{max-width:100%}pre,table{overflow-x:auto;display:block}
.card,.option{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:12px 0}
.options{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr))}
.options .option{margin:0}
#variants{position:sticky;top:0;display:flex;gap:8px;flex-wrap:wrap;padding:8px 16px;background:var(--bg);border-bottom:1px solid var(--line)}
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
            'bind': pick('DEMO_BIND', 'bind', '0.0.0.0'), 'data': data}


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


def build_index(text, title):
    if FULL_DOC.match(text.lstrip('\ufeff')):
        return text
    return FRAME.replace('__TITLE__', title).replace('__BODY__', text)


def publish(src, name):
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
        index.write_text(build_index(index.read_text(encoding='utf-8'), name), encoding='utf-8')
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


def main(argv):
    if argv[:1] == ['serve']:
        return serve()
    if argv[:1] == ['publish'] and len(argv) >= 4 and argv[2] == '--name':
        return publish(argv[1], argv[3])
    raise SystemExit('usage: demo.py serve | demo.py publish <folder|file> --name <name>')


if __name__ == '__main__':
    main(sys.argv[1:])
