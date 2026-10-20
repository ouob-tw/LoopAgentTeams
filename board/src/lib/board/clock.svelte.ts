// The moment and time zone the notice times are read against: the board's calendar day, which moves
// on at midnight with the page open. On the server it is always the moment of the request.
class Clock {
	#tick = $state(Date.now());
	/** The host's time zone, as the server's snapshot gives it. */
	timeZone = $state('UTC');
	get now(): number {
		return typeof window !== 'undefined' ? this.#tick : Date.now();
	}
	/** Start moving on; returns the function that stops it. */
	run(): () => void {
		this.#tick = Date.now();
		const timer = setInterval(() => (this.#tick = Date.now()), 60_000);
		return () => clearInterval(timer);
	}
}

export const clock = new Clock();
