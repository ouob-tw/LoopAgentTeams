import type { IncomingMessage } from 'node:http';
import type { Device } from '#lib/server/devices.ts';

declare global {
	namespace App {
		interface Locals {
			/** The logged-in device the request came from, or null. */
			device: Device | null;
			/** The browser's address: the connection's own, or what a trusted proxy says it is. */
			clientAddress: string;
			/** Whether the browser reached the board over HTTPS, which only a trusted proxy can say. */
			https: boolean;
			/** The id every log line about this request carries. */
			requestId: string;
			/** Take the request's user text and token out of a text before it is logged. */
			redact: (text: string) => Promise<string>;
		}
		interface Platform {
			/** The Node request adapter-node passes, whose socket is the connection itself. */
			req?: IncomingMessage;
		}
		interface PageState {
			/** How many of the board's history entries lie behind this one; see navigation.ts. */
			depth?: number;
		}
	}
}

export {};
