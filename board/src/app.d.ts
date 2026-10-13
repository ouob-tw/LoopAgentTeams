declare global {
	namespace App {
		interface Locals {
			/** ID of the paired device making this request; unset when the browser is not paired. */
			deviceId?: string;
		}
	}
}

export {};
