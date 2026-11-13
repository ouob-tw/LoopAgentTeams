// The evidence window of the review tab: which controller's file is open, if any. `opened` counts
// the presses, so pressing the same link again opens the window again.
export const evidenceView = $state<{ controllerId: string | null; path: string | null; opened: number }>({ controllerId: null, path: null, opened: 0 });

export function openEvidence(controllerId: string, path: string): void {
	evidenceView.controllerId = controllerId;
	evidenceView.path = path;
	evidenceView.opened++;
}
