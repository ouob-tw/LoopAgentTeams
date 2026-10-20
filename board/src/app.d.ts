import type { Device } from '#lib/server/devices.ts';

declare global {
	namespace App {
		interface Locals {
			/** The logged-in device the request came from, or null. */
			device: Device | null;
		}
		interface PageState {
			/** How many of the board's history entries lie behind this one; see navigation.ts. */
			depth?: number;
		}
	}
}

export {};
