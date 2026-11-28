// The 分享 button a logged-in viewer sees at the top right of an HTML demo page (#745): a link to
// the board's settings at that demo's 示意頁分享 switch, reading 已分享 when the demo is shared. It
// is only a link: sharing changes on the board alone, which refuses changes sent from the demo
// address (hooks.server.ts). A viewer without the login, reading a shared demo, gets the file as
// published. The button lives in a closed shadow root on a host styled inline with !important, so
// the page's CSS can neither move nor restyle it; it sits under demo.py's image viewer (z-index
// 2147483000), so an opened picture covers it. On a page with demo.py's switch bar, the bar's tabs
// wrap short of it. Frames of the demo's own pages get none. The script is plain ASCII, so it reads
// the same in any encoding that keeps ASCII as it is (UTF-16 does not), and no content policy on the
// demo answers (security-headers.ts) limits scripts; a policy the page sets itself in a <meta> can.
import { demoShareHref } from '#lib/board/demo-share-link.ts';

/** What the button shows and where it leads. */
export interface ShareButton {
	/** The board's own origin, or '' for a page under the board's own /demo. */
	board: string;
	shared: boolean;
}

const SHARE_ICON =
	'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg>';
const SHARED_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

/** The button's look, inside its shadow root: the board's colours, light or dark as the system is.
 *  It shows 32px high, to cover as little of the page's top as it can; on a touch screen its tap
 *  area reaches 44px, up to the window's edge. */
const STYLE =
	':host{all:initial}' +
	'a{position:relative;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;' +
	'border:1px solid #111;border-radius:99px;background:#fff;color:#000;text-decoration:none;' +
	'font:700 16px/1 system-ui,"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;' +
	'box-shadow:0 1px 4px rgba(0,0,0,.25);cursor:pointer;-webkit-tap-highlight-color:transparent}' +
	'@media (pointer:coarse){a::before{content:"";position:absolute;inset:-6px 0}}' +
	'a:hover{background:#f0f0f0}a:focus-visible{outline:3px solid #0b3d91;outline-offset:2px}' +
	'svg{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}' +
	'.shared svg{stroke:#14532d;stroke-width:3}' +
	'@media (prefers-color-scheme:dark){a{border-color:#8b919a;background:#181b1f;color:#e6e3dc;box-shadow:0 1px 4px rgba(0,0,0,.6)}' +
	'a:hover{background:#2a2f36}a:focus-visible{outline-color:#6cb6ff}.shared svg{stroke:#57c785}}';

/** The host's place on the page; inline and !important, so no rule of the page's outweighs it. */
const HOST_STYLE =
	'all:initial!important;display:block!important;position:fixed!important;' +
	'top:max(6px,env(safe-area-inset-top))!important;right:max(8px,env(safe-area-inset-right))!important;' +
	'z-index:2147482000!important;margin:0!important;transform:none!important;visibility:visible!important;opacity:1!important';

/** A JS string literal of `text` that stays inside its <script>, written in ASCII alone. */
function literal(text: string): string {
	return JSON.stringify(text).replace(/[^\x20-\x7e]|[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** The <script> that puts the button on the page `name`. */
export function shareButtonScript(name: string, button: ShareButton): string {
	const label = button.shared ? '已分享' : '分享';
	const markup =
		`<style>${STYLE}</style>` +
		`<a href="${demoShareHref(button.board, name)}" target="_top"${button.shared ? ' class="shared"' : ''} title="到看板設定分享">` +
		`${button.shared ? SHARED_ICON : SHARE_ICON}<span>${label}</span></a>`;
	return (
		'<script>(function(){if(window.top!==window.self)return;' +
		"var h=document.createElement('lat-demo-share');" +
		`h.setAttribute('style',${literal(HOST_STYLE)});` +
		`h.attachShadow({mode:'closed'}).innerHTML=${literal(markup)};` +
		'document.documentElement.appendChild(h);' +
		// demo.py's own switch bar, first in the body, runs along the top: its tabs wrap short of the
		// button, which lines up with their first row (the bar sticks at the window's top).
		"var bar=document.querySelector('body>nav#variants:first-child'),tab=bar&&bar.querySelector('button');if(!tab)return;" +
		"var t=tab.getBoundingClientRect();bar.style.setProperty('padding-right',h.offsetWidth+16+'px','important');" +
		"h.style.setProperty('top','max('+Math.max(0,t.top-bar.getBoundingClientRect().top+(t.height-h.offsetHeight)/2)+'px,env(safe-area-inset-top))','important')})()</script>"
	);
}

/** The page's bytes with the button's script after them: the parser puts what follows the document
 *  in its body, so it runs once the page above it is read. Nothing the page wrote moves, but for
 *  demo.py's switch bar (above). */
export function withShareButton(page: Buffer<ArrayBuffer>, name: string, button: ShareButton): Buffer<ArrayBuffer> {
	return Buffer.concat([page, Buffer.from(shareButtonScript(name, button), 'ascii')]);
}
