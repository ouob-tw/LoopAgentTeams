// The evidence window of the review tab: which controller's file is open, if any.
export const evidenceView = $state<{ controllerId: string | null; path: string | null }>({ controllerId: null, path: null });

export function openEvidence(controllerId: string, path: string): void {
	evidenceView.controllerId = controllerId;
	evidenceView.path = path;
}
