"""Markdown rendering of publish-md: structure, escaping, safe links, and the published page."""
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/demo.py'
spec = importlib.util.spec_from_file_location('demo', SCRIPT)
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)

REPORT = '''# 週報 <b>

| 主機 | 高 | 中 | 說明 |
| :-- | --: | :-: | --- |
| s1 | 1 | 0 | `ssh` 密碼登入 |
| s2 | 0 | 2 | a \\| b |

```bash
echo "<script>alert(1)</script>" && ls | wc -l
```

- 一
  - 一之一
- [x] 完成
1. 第一
2. **粗** 與 *斜* 與 [連結](https://example.com/a?b=1&c=2)

> 引用 `x`

---
'''


class RenderTests(unittest.TestCase):
    def html(self, text=REPORT):
        return demo.md_to_html(text)

    def test_structure(self):
        h = self.html()
        self.assertIn('<h1>週報 &lt;b&gt;</h1>', h)
        self.assertEqual(h.count('<tr>'), 3)
        self.assertIn('<th style="text-align:right">高</th>', h)
        self.assertIn('<th style="text-align:center">中</th>', h)
        self.assertIn('<td><code>ssh</code> 密碼登入</td>', h)
        self.assertIn('<td>a | b</td>', h)
        self.assertIn('<div class="tbl" tabindex="0"><table>', h)
        self.assertIn('<ol><li>第一</li><li><strong>粗</strong> 與 <em>斜</em> 與', h)
        self.assertIn('<blockquote><p>引用 <code>x</code></p></blockquote>', h)
        self.assertIn('<hr>', h)
        self.assertIn('☑ 完成', h)
        self.assertIn('<ul><li>一<ul><li>一之一</li></ul></li><li>☑ 完成</li></ul>', h)

    def test_code_block_is_literal(self):
        h = self.html()
        self.assertIn('<pre><code class="language-bash">echo "&lt;script&gt;alert(1)&lt;/script&gt;" &amp;&amp; ls | wc -l</code></pre>', h)

    def test_source_html_cannot_inject(self):
        evil = ('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n'
                '| <i>h</i> |\n| --- |\n| <script>x</script> |\n\n'
                '[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](data:text/html,x) `<script>`\n\n'
                '[d](https://x.test/"onmouseover="alert(1))\n')
        h = self.html(evil)
        for bad in ('<script', '<img', '<i>', 'href="javascript', 'href="data:', 'href="JaVa'):
            self.assertNotIn(bad, h)
        self.assertIn('&lt;script&gt;alert(1)&lt;/script&gt;', h)
        self.assertNotIn('" onmouseover', h)
        self.assertNotIn('"onmouseover=', h.replace('&quot;onmouseover=', ''))

    def test_safe_links_kept(self):
        h = self.html('[ok](https://example.com/a?b=1&c=2) [m](mailto:a@b.c) [r](docs/a.md)')
        self.assertIn('<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer">ok</a>', h)
        self.assertIn('href="mailto:a@b.c"', h)
        self.assertIn('href="docs/a.md"', h)

    def test_unclosed_fence_and_empty_input(self):
        self.assertIn('<pre><code>a\nb</code></pre>', self.html('```\na\nb'))
        self.assertEqual(self.html(''), '<div class="md"></div>')

    def test_title_from_first_heading(self):
        self.assertEqual(demo.md_title('x\n# **Hi** `a`\n', 'n'), 'Hi a')
        self.assertEqual(demo.md_title('no heading', 'n'), 'n')

    def test_wide_table_scrolls_inside_its_box(self):
        page = demo.md_page(REPORT, 'n')
        self.assertIn('.md .tbl{overflow-x:auto;max-width:100%', page)
        self.assertIn('width:max-content;min-width:100%;max-width:none', page)  # the frame's table{max-width:100%} would squeeze columns


class PublishMdTests(unittest.TestCase):
    def test_publishes_framed_page_with_escaped_title(self):
        with tempfile.TemporaryDirectory() as t:
            data = Path(t) / 'data'
            env = {**os.environ, 'HOME': t, 'DEMO_PORT': '7163', 'DEMO_BIND': '127.0.0.1', 'DEMO_HOST': '127.0.0.1', 'DEMO_DATA': str(data)}
            server = subprocess.Popen([sys.executable, str(SCRIPT), 'serve'], env=env)
            try:
                import http.client, time
                for _ in range(50):
                    try:
                        http.client.HTTPConnection('127.0.0.1', 7163, timeout=1).connect()
                        break
                    except OSError:
                        time.sleep(0.1)
                md = Path(t) / 'r.md'
                md.write_text(REPORT, encoding='utf-8')
                r = subprocess.run([sys.executable, str(SCRIPT), 'publish-md', str(md), '--name', 'md1'], capture_output=True, text=True, env=env)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertTrue(r.stdout.startswith('http://127.0.0.1:7163/md1/?k='))
                page = (data / 'site/md1/index.html').read_text(encoding='utf-8')
                self.assertIn('<title>週報 &lt;b&gt;</title>', page)
                self.assertIn('<meta name="viewport"', page)
                self.assertIn('prefers-color-scheme:dark', page)
                self.assertNotIn('<b>', page.split('<main>')[1].split('</main>')[0].replace('<br>', ''))
                missing = subprocess.run([sys.executable, str(SCRIPT), 'publish-md', str(Path(t) / 'no.md'), '--name', 'md2'], capture_output=True, text=True, env=env)
                self.assertNotEqual(missing.returncode, 0)
            finally:
                server.terminate()
                server.wait()


if __name__ == '__main__':
    unittest.main()
