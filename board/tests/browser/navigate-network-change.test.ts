// A page load that lost a request to a change in the host's network (Docker adding or removing an
// interface is enough) loads again, and the page given up on leaves no errors behind; any other
// failed request, and a load that keeps losing them, is left as it is.
import { expect, test } from 'bun:test';
import { Tab } from '../browser.ts';

/** How one load goes: the error its document or its module request ends with, if any. */
type Load = { document?: string; module?: string };

/** A socket in place of Chrome's: each Page.navigate is the next of `loads`, a document whose module
 *  request ends as that load says, with an error thrown in the page when it fails. */
class Transport extends EventTarget {
	navigations = 0;
	constructor(private loads: Load[]) {
		super();
	}
	/** Sent after the call that asked, as Chrome's answers are: the tab waits for it only then. */
	#emit(message: object) {
		setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })));
	}
	send(text: string) {
		const { id, method } = JSON.parse(text);
		if (method !== 'Page.navigate') return this.#emit({ id, result: {} });
		const load = this.loads[this.navigations++];
		const loaderId = `loader-${this.navigations}`;
		const requestId = `module-${this.navigations}`;
		this.#emit({ id, result: { frameId: 'main', loaderId, errorText: load.document } });
		if (load.document) return;
		this.#emit({ method: 'Page.frameNavigated', params: { frame: { id: 'main', loaderId } } });
		this.#emit({ method: 'Network.requestWillBeSent', params: { requestId, loaderId } });
		if (load.module) {
			this.#emit({ method: 'Network.loadingFailed', params: { requestId, errorText: load.module } });
			this.#emit({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: `failed module in ${loaderId}` } } });
		} else {
			this.#emit({ method: 'Network.loadingFinished', params: { requestId } });
		}
		this.#emit({ method: 'Page.lifecycleEvent', params: { name: 'load', loaderId } });
	}
	close() {
		this.dispatchEvent(new Event('close'));
	}
}

const CHANGED = 'net::ERR_NETWORK_CHANGED';

test('a load that lost a request to a network change loads again, without the dropped page\'s errors', async () => {
	const transport = new Transport([{ module: CHANGED }, {}]);
	const tab = new Tab(transport as unknown as WebSocket);
	tab.errors.push('an error from before');
	await tab.navigate('http://board/');
	expect(transport.navigations).toBe(2);
	expect(tab.errors).toEqual(['an error from before']);
});

test('the page loaded again keeps its own errors', async () => {
	const transport = new Transport([{ module: CHANGED }, { module: 'net::ERR_FAILED' }]);
	const tab = new Tab(transport as unknown as WebSocket);
	await tab.navigate('http://board/');
	expect(transport.navigations).toBe(2);
	expect(tab.errors).toEqual(['failed module in loader-2']);
});

test('a document lost to a network change is asked for again', async () => {
	const transport = new Transport([{ document: CHANGED }, {}]);
	const tab = new Tab(transport as unknown as WebSocket);
	await tab.navigate('http://board/');
	expect(transport.navigations).toBe(2);
	expect(tab.errors).toEqual([]);
});

test('any other failed request loads once, its error kept', async () => {
	const transport = new Transport([{ module: 'net::ERR_CONNECTION_REFUSED' }, {}]);
	const tab = new Tab(transport as unknown as WebSocket);
	await tab.navigate('http://board/');
	expect(transport.navigations).toBe(1);
	expect(tab.errors).toEqual(['failed module in loader-1']);
});

test('a load that keeps losing requests stops after three, the last page as it is', async () => {
	const transport = new Transport([{ module: CHANGED }, { module: CHANGED }, { module: CHANGED }, {}]);
	const tab = new Tab(transport as unknown as WebSocket);
	await tab.navigate('http://board/');
	expect(transport.navigations).toBe(3);
	expect(tab.errors).toEqual(['failed module in loader-3']);
});
