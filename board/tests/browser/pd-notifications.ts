// What the pd browser tests share about notifications.

/** pd notifications recorded instead of shown, run first in every document: each one the page asks
 *  its service worker (static/pd-sw.js) to show goes to `window.__notes` as `{ title, body, tag }`;
 *  as in Chrome, it is refused while permission is not granted.
 *  The window counts as unfocused, so the board is in the background and notifies. Notification
 *  permission starts as `permission`; asking for it grants it and records in `window.__asked`
 *  whether a user gesture was under way. The constructor throws, as on Android Chrome. */
export const fakeNotifications = (permission: NotificationPermission = 'granted') => `(() => {
	let permission = ${JSON.stringify(permission)};
	window.__asked = [];
	window.__notes = [];
	window.Notification = class {
		static get permission() { return permission; }
		static async requestPermission() { window.__asked.push(navigator.userActivation.isActive); permission = 'granted'; return permission; }
		constructor() { throw new TypeError("Failed to construct 'Notification': Illegal constructor"); }
	};
	Document.prototype.hasFocus = () => false;
	if (window.ServiceWorkerRegistration) {
		ServiceWorkerRegistration.prototype.showNotification = async (title, options) => {
			if (permission !== 'granted') throw new TypeError('No notification permission has been granted for this origin.');
			window.__notes.push({ title, body: options?.body, tag: options?.tag });
		};
	}
})()`;
