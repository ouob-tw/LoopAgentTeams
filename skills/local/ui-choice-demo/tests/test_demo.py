"""demo.py contracts: publish, overwrite, key, fragment vs full document, 14-day cleanup."""
import http.client
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/demo.py'
PORT = 7161


def load():
    spec = importlib.util.spec_from_file_location('demo', SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class DemoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {**os.environ, 'HOME': self.temp.name, 'DEMO_PORT': str(PORT), 'DEMO_BIND': '127.0.0.1',
                    'DEMO_HOST': 'demo.test', 'DEMO_DATA': str(self.root / 'data')}
        self.server = subprocess.Popen([sys.executable, str(SCRIPT), 'serve'], env=self.env)
        self.addCleanup(self.server.wait)
        self.addCleanup(self.server.terminate)
        for _ in range(50):
            try:
                http.client.HTTPConnection('127.0.0.1', PORT, timeout=1).connect()
                break
            except OSError:
                time.sleep(0.1)

    def publish(self, src, name='d1'):
        return subprocess.run([sys.executable, str(SCRIPT), 'publish', str(src), '--name', name],
                              capture_output=True, text=True, env=self.env)

    def get(self, path, headers=None):
        c = http.client.HTTPConnection('127.0.0.1', PORT, timeout=5)
        c.request('GET', path, headers=headers or {})
        r = c.getresponse()
        return r.status, r.read().decode(), r

    def make(self, text, name='src'):
        d = self.root / name
        d.mkdir(exist_ok=True)
        (d / 'index.html').write_text(text)
        return d

    def test_publish_prints_one_verified_url(self):
        r = self.publish(self.make('<p>hi</p>'))
        self.assertEqual(r.returncode, 0, r.stderr)
        url = r.stdout.strip()
        self.assertEqual(len(r.stdout.strip().splitlines()), 1)
        self.assertRegex(url, r'^http://demo\.test:7161/d1/\?k=\S+$')
        status, body, _ = self.get(url.split('demo.test:7161')[1])
        self.assertEqual(status, 200)
        self.assertIn('hi', body)

    def test_publish_fails_when_server_down(self):
        self.server.terminate()
        self.server.wait()
        r = self.publish(self.make('<p>x</p>'))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('cannot be opened', r.stderr)

    def test_overwrite_shows_new_version_at_same_url(self):
        url = self.publish(self.make('<p>OLDTEXT</p>')).stdout.strip().split('demo.test:7161')[1]
        self.publish(self.make('<p>NEWTEXT</p>'))
        self.assertIn('NEWTEXT', self.get(url)[1])
        self.assertNotIn('OLDTEXT', self.get(url)[1])

    def test_key_rejection_and_cookie(self):
        url = self.publish(self.make('<p>hi</p>')).stdout.strip().split('demo.test:7161')[1]
        key = url.split('k=')[1]
        self.assertEqual(self.get('/d1/')[0], 403)
        self.assertEqual(self.get('/d1/?k=wrong')[0], 403)
        self.assertEqual(self.get('/d1/', {'Cookie': 'demo_key=wrong'})[0], 403)
        status, _, resp = self.get(url)
        self.assertEqual(status, 200)
        cookie = resp.getheader('Set-Cookie').split(';')[0]
        self.assertEqual(cookie, f'demo_key={key}')
        self.assertEqual(self.get('/d1/', {'Cookie': cookie})[0], 200)

    def test_cookie_covers_files_in_the_page(self):
        d = self.make('<p>hi</p>')
        (d / 'a.css').write_text('b{}')
        url = self.publish(d).stdout.strip().split('demo.test:7161')[1]
        cookie = f'demo_key={url.split("k=")[1]}'
        self.assertEqual(self.get('/d1/a.css', {'Cookie': cookie})[0], 200)
        self.assertEqual(self.get('/d1/a.css')[0], 403)

    def test_no_traversal_or_listing(self):
        url = self.publish(self.make('<p>hi</p>')).stdout.strip().split('demo.test:7161')[1]
        cookie = {'Cookie': f'demo_key={url.split("k=")[1]}'}
        self.assertEqual(self.get('/', cookie)[0], 404)
        self.assertNotEqual(self.get('/../../.key', cookie)[0], 200)
        self.assertNotIn('data', self.get('/.key', cookie)[1])

    def test_fragment_gets_frame_full_document_stays(self):
        u1 = self.publish(self.make('<h1>frag</h1>', 'a'), 'frag').stdout.strip().split('demo.test:7161')[1]
        body = self.get(u1)[1]
        self.assertIn('<h1>frag</h1>', body)
        self.assertIn('viewport', body)
        self.assertIn('prefers-color-scheme', body)
        full = '<!doctype html><html><body>own</body></html>'
        u2 = self.publish(self.make(full, 'b'), 'full').stdout.strip().split('demo.test:7161')[1]
        self.assertEqual(self.get(u2)[1], full)
        u3 = self.publish(self.make('  <HTML><body>own</body></HTML>', 'c'), 'full2').stdout.strip().split('demo.test:7161')[1]
        self.assertNotIn('viewport', self.get(u3)[1])

    def test_single_file_and_bad_name(self):
        f = self.root / 'one.html'
        f.write_text('<p>solo</p>')
        self.assertEqual(self.publish(f, 'solo').returncode, 0)
        self.assertNotEqual(self.publish(f, '../x').returncode, 0)
        self.assertNotEqual(self.publish(f, 'Bad Name').returncode, 0)

    def test_cleanup_removes_only_demos_older_than_14_days(self):
        demo = load()
        site = self.root / 'site'
        for n in ('old', 'fresh'):
            (site / n).mkdir(parents=True)
        now = time.time()
        os.utime(site / 'old', (now - 15 * 86400, now - 15 * 86400))
        os.utime(site / 'fresh', (now - 13 * 86400, now - 13 * 86400))
        self.assertEqual(demo.cleanup(site, now), ['old'])
        self.assertTrue((site / 'fresh').exists())
        self.assertFalse((site / 'old').exists())

    def test_republish_refreshes_age(self):
        self.publish(self.make('<p>a</p>'))
        site = self.root / 'data/site/d1'
        old = time.time() - 20 * 86400
        os.utime(site, (old, old))
        self.publish(self.make('<p>b</p>'))
        self.assertEqual(load().cleanup(self.root / 'data/site'), [])


if __name__ == '__main__':
    unittest.main()
