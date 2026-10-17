declare global {
	namespace App {
		interface PageState {
			/** How many of the board's history entries lie behind this one; see navigation.ts. */
			depth?: number;
		}
	}
}

export {};
