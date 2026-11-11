// The board's service worker, only for pd notifications: a page shows them through it
// (registration.showNotification), the one way Android Chrome allows. It caches nothing and
// handles no fetches. A click on one brings a board tab to the front and has it open the pd
// window; with no board tab open it opens one, which opens the window itself for a waiting request.
self.addEventListener('install', () => self.skipWaiting());
// Taken over at once, so a click reaches the tab that registered it before it ever reloads.
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	event.waitUntil(
		self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
			const board = tabs.find((tab) => new URL(tab.url).pathname === '/');
			if (!board) return self.clients.openWindow('/');
			board.postMessage({ type: 'pd-open' });
			return board.focus();
		})
	);
});
