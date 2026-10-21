// The page's one way to ask the board server: a device no longer logged in goes to the login
// screen, and every other failure comes back as what it was, for the caller to word.
import { expect, test } from 'bun:test';
import { createRequest } from '../../src/lib/board/api.ts';

function server(answer: () => Response | Promise<Response>) {
	let unpaired = 0;
	const request = createRequest({ fetch: async () => answer(), unpaired: () => unpaired++ });
	return { request, unpaired: () => unpaired };
}

test('an answer read as JSON is the value', async () => {
	const { request } = server(() => Response.json({ entries: [1] }));
	expect(await request<{ entries: number[] }>('/api/messages')).toEqual({ ok: true, value: { entries: [1] } });
});

test('401 sends the device to the login screen and says so', async () => {
	const { request, unpaired } = server(() => new Response(null, { status: 401 }));
	const result = await request('/api/messages');
	expect(result).toMatchObject({ ok: false, kind: 'http', status: 401, unpaired: true });
	expect(unpaired()).toBe(1);
});

test('500 is an http failure carrying the body the server sent', async () => {
	const { request, unpaired } = server(() => Response.json({ ok: false, reason: '壞了' }, { status: 500 }));
	const result = await request('/api/model');
	expect(result).toMatchObject({ ok: false, kind: 'http', status: 500, body: { ok: false, reason: '壞了' } });
	expect(result.ok || result.unpaired).toBeFalsy();
	expect(unpaired()).toBe(0);
});

test('a 2xx answer that is not JSON is a json failure', async () => {
	const { request } = server(() => new Response('<html>', { status: 200 }));
	expect(await request('/api/launches')).toMatchObject({ ok: false, kind: 'json', status: 200 });
});

test('no answer at all is a network failure', async () => {
	const { request, unpaired } = server(() => Promise.reject(new TypeError('Failed to fetch')));
	expect(await request('/api/wake', { method: 'POST' })).toMatchObject({ ok: false, kind: 'network' });
	expect(unpaired()).toBe(0);
});

test('a caller reading the body itself gets the response', async () => {
	const { request } = server(() => new Response('a\nb', { status: 200 }));
	const result = await request('/api/translate', undefined, (response) => response.text());
	expect(result).toEqual({ ok: true, value: 'a\nb' });
});
