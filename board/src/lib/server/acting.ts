// Which logged-in device the request being handled comes from, for whatever it writes down on the
// way (the sent log names a test device's actions). Set once per request in hooks.server.ts.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Device } from './devices.ts';

const context = new AsyncLocalStorage<Device | null>();

export const actingAs = <T>(device: Device | null, run: () => T): T => context.run(device, run);

/** The test device acting now; null for a password device, and outside a request. */
export function actingTestDevice(): Device | null {
	const device = context.getStore() ?? null;
	return device?.test ? device : null;
}
