// The page's requests to the board server. A device no longer logged in (401) reloads the page,
// which the server answers with the login screen; every other failure is returned as what it was,
// for the caller to word: each action words "no answer came back" its own way.

export type Fetch = (path: string, init: RequestInit) => Promise<Response>;

export type ApiResult<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			/** `http`: the server answered with a status that is not 2xx. `network`: no answer came
			 *  back, or the request was aborted. `json`: a 2xx answer that could not be read. */
			kind: 'http' | 'network' | 'json';
			status?: number;
			message: string;
			/** With `http`: the answer's JSON body, or null when it has none. */
			body?: unknown;
			/** With `http`: the device is no longer logged in, and the page is being reloaded. */
			unpaired?: boolean;
	  };

export type Request = <T = unknown>(path: string, init?: RequestInit, read?: (response: Response) => Promise<T>) => Promise<ApiResult<T>>;

/** Load the page again: the server sends a browser that is not logged in to the login screen. */
export function reloadPage(): void {
	location.reload();
}

export function createRequest({ fetch: send = (path, init) => fetch(path, init), unpaired = reloadPage }: { fetch?: Fetch; unpaired?: () => void } = {}): Request {
	return async <T>(path: string, init?: RequestInit, read: (response: Response) => Promise<T> = (response) => response.json()) => {
		let response: Response;
		try {
			response = await send(path, init ?? {});
		} catch (error) {
			return { ok: false, kind: 'network', message: String(error) };
		}
		if (!response.ok) {
			const failed = { ok: false, kind: 'http', status: response.status, message: `HTTP ${response.status}` } as const;
			if (response.status === 401) {
				unpaired();
				return { ...failed, body: null, unpaired: true };
			}
			return { ...failed, body: await response.json().catch(() => null) };
		}
		try {
			return { ok: true, value: await read(response) };
		} catch (error) {
			return { ok: false, kind: 'json', status: response.status, message: String(error) };
		}
	};
}

export const request = createRequest();
