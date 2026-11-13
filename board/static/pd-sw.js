// The board's service worker, for notifications only: it caches nothing and handles no fetches.
// pd notifications: a page shows them through it (registration.showNotification), the one way
// Android Chrome allows; a click brings a board tab to the front and has it open the pd window, and
// with no board tab open it opens one, which opens the window itself for a waiting request.
// Automation red cards: the board sends a Web Push (the task's name and one sentence) even when no
// board tab is open; a click opens that card, in a board tab already open or in a new one.
self.addEventListener('install', () => self.skipWaiting());
// Taken over at once, so a click reaches the tab that registered it before it ever reloads.
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
	let message = {};
	try {
		message = event.data ? event.data.json() : {};
	} catch {
		// Not the board's: shown with the board's own words below.
	}
	const alert = typeof message.alert === 'string' ? message.alert : '';
	const title = typeof message.title === 'string' && message.title ? message.title : 'LAT 看板';
	const body = typeof message.body === 'string' ? message.body : '自動化有新的紅卡';
	event.waitUntil(self.registration.showNotification(title, { body, tag: alert ? `alert-${alert}` : 'alert', data: { alert } }));
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const given = event.notification.data?.alert;
	const alert = typeof given === 'string' && given ? given : null;
	const target = alert ? `/?alert=${encodeURIComponent(alert)}` : '/';
	event.waitUntil(
		self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
			const board = tabs.find((tab) => new URL(tab.url).pathname === '/');
			if (!board) return self.clients.openWindow(target);
			board.postMessage(alert ? { type: 'alert-open', alert } : { type: 'pd-open' });
			return board.focus();
		})
	);
});
