import type { Device } from '#lib/server/devices.ts';

declare global {
	namespace App {
		interface Locals {
			/** The logged-in device the request came from, or null. */
			device: Device | null;
			/** The id every log line about this request carries. */
			requestId: string;
			/** Take the request's user text and token out of a text before it is logged. */
			redact: (text: string) => Promise<string>;
		}
		interface PageState {
			/** How many of the board's history entries lie behind this one; see navigation.ts. */
			depth?: number;
		}
	}
}

export {};
