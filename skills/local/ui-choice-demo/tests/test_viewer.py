"""Image viewer added by demo.py: injection rules (plain) and behaviour in a real Chromium (needs playwright)."""
import base64
import importlib.util
import math
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/demo.py'
spec = importlib.util.spec_from_file_location('demo', SCRIPT)
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)

SVG = base64.b64encode(b'<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">'
                       b'<rect width="1600" height="900" fill="#cde"/></svg>').decode()
IMG = f'<img id="a" src="data:image/svg+xml;base64,{SVG}" style="width:480px">'


class InjectionTests(unittest.TestCase):
    def test_fragment_and_full_page_both_get_it_once(self):
        frag = demo.build_index(IMG, 't')
        full = demo.build_index(f'<!doctype html><html><body>{IMG}</body></html>', 't')
        bare = demo.build_index('<!doctype html><p>no body tag</p>', 't')
        for html in (frag, full, bare):
            self.assertEqual(html.count(demo.VIEWER_MARK), 1)
            self.assertEqual(demo.build_index(html, 't').count(demo.VIEWER_MARK), 1)
        self.assertLess(full.index(demo.VIEWER_MARK), full.lower().rindex('</body>'))
        self.assertTrue(bare.endswith('</script>'))

    def test_script_cannot_close_its_own_tag(self):
        js = (SCRIPT.parent / 'viewer.js').read_text()
        self.assertNotIn('</script', js.lower())
        self.assertNotIn('<!--', js)


try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None


@unittest.skipUnless(sync_playwright, 'playwright not installed')
class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        try:
            cls.browser = cls.pw.chromium.launch()
        except Exception:  # the pinned browser build is not downloaded: use any installed Chromium
            found = sorted(Path.home().glob('.cache/ms-playwright/chromium-*/chrome-linux64/chrome'))
            if not found:
                cls.pw.stop()
                raise unittest.SkipTest('no Chromium available')
            cls.browser = cls.pw.chromium.launch(executable_path=str(found[-1]))
        cls.tmp = tempfile.TemporaryDirectory()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.tmp.cleanup()

    def open(self, body, touch=False, size=(1000, 700)):
        ctx = self.browser.new_context(viewport={'width': size[0], 'height': size[1]}, has_touch=touch)
        self.addCleanup(ctx.close)
        f = Path(self.tmp.name) / f'p{id(ctx)}.html'
        f.write_text(demo.build_index(body, 't'))
        self.page = ctx.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.goto(f'file://{f}')
        self.ctx = ctx
        return self.page

    def view(self):
        """Overlay picture box, or None when closed."""
        return self.page.evaluate('''() => {
          const h = [...document.body.children].find(e => e.shadowRoot);
          if (!h) return null;
          const r = h.shadowRoot.querySelector('img').getBoundingClientRect();
          return {x: r.x, y: r.y, w: r.width, h: r.height};
        }''')

    def fire(self, js_event):
        self.page.evaluate('''(src) => {
          const h = [...document.body.children].find(e => e.shadowRoot);
          const root = h.shadowRoot.querySelector('.root');
          window.__last = (new Function('root', src))(root);
        }''', js_event)
        return self.page.evaluate('window.__last')

    def wheel(self, dy, dx=0, ctrl=False, x=500, y=350, mode=0):
        return self.fire(f'''const e = new WheelEvent('wheel', {{deltaX:{dx}, deltaY:{dy}, ctrlKey:{str(ctrl).lower()},
          deltaMode:{mode}, clientX:{x}, clientY:{y}, bubbles:true, cancelable:true, composed:true}});
          root.dispatchEvent(e); return e.defaultPrevented;''')

    def test_click_opens_fitted_and_every_way_of_closing_works(self):
        p = self.open(IMG)
        p.click('#a')
        v = self.view()
        self.assertLessEqual(v['x'], 1)
        self.assertGreaterEqual(v['x'] + v['w'], 999)  # 1600x900 fits the 1000 width exactly
        self.assertLessEqual(v['y'] + v['h'], 700)
        self.assertAlmostEqual(v['w'] / v['h'], 1600 / 900, places=2)
        p.keyboard.press('Escape')
        self.assertIsNone(self.view())
        p.click('#a')
        p.mouse.click(500, 5)  # empty space above the picture
        self.assertIsNone(self.view())
        p.click('#a')
        self.fire("root.querySelector('.close').click()")
        self.assertIsNone(self.view())
        self.assertEqual(self.errors, [])

    def test_small_picture_is_not_blown_up_past_its_page_size(self):
        small = base64.b64encode(b'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100"/></svg>').decode()
        p = self.open(f'<img id="a" src="data:image/svg+xml;base64,{small}">')
        p.click('#a')
        self.assertLessEqual(self.view()['w'], 200 * 1.01)

    def test_link_images_and_opt_outs_are_left_alone(self):
        p = self.open(f'<a href="#x">{IMG}</a><div data-no-zoom><img id="b" src="data:image/svg+xml;base64,{SVG}" style="width:300px"></div>')
        p.click('#a')
        self.assertIsNone(self.view())
        self.assertTrue(p.url.endswith('#x'))
        p.click('#b')
        self.assertIsNone(self.view())

    def test_page_handler_that_prevents_default_keeps_the_click(self):
        p = self.open(IMG + '<script>document.getElementById("a").addEventListener("click",e=>e.preventDefault())</script>')
        p.click('#a')
        self.assertIsNone(self.view())

    def test_pinch_wheel_follows_the_fingers_not_a_fixed_step(self):
        self.open(IMG).click('#a')
        w0 = self.view()['w']
        self.assertTrue(self.wheel(-5, ctrl=True))
        w1 = self.view()['w']
        self.assertAlmostEqual(w1 / w0, math.exp(0.05), places=2)
        self.wheel(-5, ctrl=True)
        self.assertAlmostEqual(self.view()['w'] / w1, math.exp(0.05), places=2)
        self.wheel(8, ctrl=True)
        self.assertAlmostEqual(self.view()['w'] / w1, math.exp(0.05 - 0.08), places=2)

    def test_two_finger_swipe_pans_and_does_not_zoom(self):
        self.open(IMG).click('#a')
        for _ in range(12):
            self.wheel(-5, ctrl=True)  # zoom in so there is room to move
        v0 = self.view()
        self.wheel(12.5, dx=-20.25)
        v1 = self.view()
        self.assertAlmostEqual(v1['w'], v0['w'], places=3)
        self.assertAlmostEqual(v1['x'] - v0['x'], 20.25, places=2)
        self.assertAlmostEqual(v1['y'] - v0['y'], -12.5, places=2)

    def test_fast_flick_after_a_swipe_start_is_still_a_swipe(self):
        self.open(IMG).click('#a')
        for _ in range(3):
            self.wheel(-5, ctrl=True)
        self.wheel(3.5)          # swipe starts small and fractional
        w = self.view()['w']
        self.wheel(120)          # whole-number big step inside the same stream
        self.assertAlmostEqual(self.view()['w'], w, places=3)

    def test_mouse_wheel_notch_zooms_about_the_cursor(self):
        self.open(IMG).click('#a')
        for _ in range(12):
            self.wheel(-5, ctrl=True)  # big enough to fill the window both ways
        self.page.wait_for_timeout(300)  # the swipe latch ends after a pause
        v0 = self.view()
        px, py = 700, 300
        ix, iy = (px - v0['x']) / v0['w'], (py - v0['y']) / v0['h']
        self.assertTrue(self.wheel(-100, x=px, y=py))
        v1 = self.view()
        self.assertAlmostEqual(v1['w'] / v0['w'], 1.2, places=2)
        self.assertAlmostEqual((px - v1['x']) / v1['w'], ix, places=2)
        self.assertAlmostEqual((py - v1['y']) / v1['h'], iy, places=2)
        self.wheel(-3, mode=1)   # Firefox-style line notch
        self.assertAlmostEqual(self.view()['w'] / v1['w'], 1.2, places=2)

    def test_zoom_is_limited_and_picture_cannot_be_dragged_away(self):
        self.open(IMG).click('#a')
        for _ in range(60):
            self.wheel(-100)
        self.assertLessEqual(self.view()['w'], 8 * 1600 + 1)
        for _ in range(200):
            self.wheel(500, dx=500, ctrl=False)
        v = self.view()
        self.assertGreaterEqual(v['x'] + v['w'], 999)
        self.assertGreaterEqual(v['y'] + v['h'], 699)
        for _ in range(80):
            self.wheel(100)
        v = self.view()
        self.assertGreaterEqual(v['w'], 1000 - 1)  # cannot shrink below the fitted size

    def test_safari_gesture_zooms_the_picture_and_blocks_page_zoom(self):
        self.open(IMG).click('#a')
        w0 = self.view()['w']
        start = self.fire('''const e = new Event('gesturestart', {bubbles:true, cancelable:true});
          e.clientX = 500; e.clientY = 350; root.dispatchEvent(e); return e.defaultPrevented;''')
        self.assertTrue(start)
        ch = self.fire('''const e = new Event('gesturechange', {bubbles:true, cancelable:true});
          e.scale = 1.5; e.clientX = 500; e.clientY = 350; root.dispatchEvent(e); return e.defaultPrevented;''')
        self.assertTrue(ch)
        self.assertAlmostEqual(self.view()['w'] / w0, 1.5, places=2)
        self.fire('''const e = new Event('gesturechange', {bubbles:true, cancelable:true});
          e.scale = 1.0; e.clientX = 500; e.clientY = 350; root.dispatchEvent(e);''')
        self.assertAlmostEqual(self.view()['w'], w0, places=2)  # relative to gesture start, not cumulative

    def test_touch_drag_pinch_and_double_tap(self):
        p = self.open(IMG, touch=True, size=(390, 700))
        p.tap('#a')
        cdp = self.ctx.new_cdp_session(p)
        v0 = self.view()
        self.assertLessEqual(v0['w'], 390.5)

        def touch(kind, pts):
            cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [
                {'x': x, 'y': y, 'id': i} for i, (x, y) in enumerate(pts)]})
        touch('touchStart', [(150, 350), (240, 350)])
        for k in range(1, 11):
            touch('touchMove', [(150 - 6 * k, 350), (240 + 6 * k, 350)])
        touch('touchEnd', [])
        v1 = self.view()
        self.assertAlmostEqual(v1['w'] / v0['w'], (90 + 120) / 90, delta=0.1)
        touch('touchStart', [(200, 350)])
        for k in range(1, 6):
            touch('touchMove', [(200 + 10 * k, 350)])
        touch('touchEnd', [])
        v2 = self.view()
        self.assertGreater(v2['x'], v1['x'] + 40)
        self.assertEqual(self.errors, [])
        # double tap returns to the fitted size
        for _ in range(2):
            touch('touchStart', [(200, 350)])
            touch('touchEnd', [])
        self.assertAlmostEqual(self.view()['w'], v0['w'], delta=1)
        # a tap on the empty area closes it
        touch('touchStart', [(200, 20)])
        touch('touchEnd', [])
        self.assertIsNone(self.view())

    def test_clicking_the_picture_itself_does_not_close(self):
        p = self.open(IMG)
        p.click('#a')
        p.mouse.click(500, 350)
        self.assertIsNotNone(self.view())

    def test_mouse_double_click_toggles_zoom(self):
        p = self.open(IMG)
        p.click('#a')
        w0 = self.view()['w']
        p.mouse.dblclick(500, 350)
        self.assertGreater(self.view()['w'], w0 * 1.5)
        p.mouse.dblclick(500, 350)
        self.assertAlmostEqual(self.view()['w'], w0, delta=1)

    def test_mouse_drag_pans_when_zoomed(self):
        p = self.open(IMG)
        p.click('#a')
        for _ in range(3):
            self.wheel(-100)
        v0 = self.view()
        p.mouse.move(500, 350)
        p.mouse.down()
        p.mouse.move(560, 380, steps=4)
        p.mouse.up()
        self.assertIsNotNone(self.view())  # dragging does not close
        v1 = self.view()
        self.assertAlmostEqual(v1['x'] - v0['x'], 60, delta=1)

    def test_page_behind_does_not_scroll_while_open(self):
        p = self.open(IMG + '<div style="height:3000px"></div>')
        p.click('#a')
        p.mouse.wheel(0, 300)
        self.assertEqual(p.evaluate('scrollY'), 0)


if __name__ == '__main__':
    unittest.main()
