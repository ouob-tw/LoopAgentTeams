// Which microphone records: the rules for listing the computer's microphones and for asking the
// browser for the chosen one. The browser's own state lives in `mic-devices.svelte.ts`.

/** The microphone the user picked, as the browser names it; nothing saved means the system default. */
export const MIC_KEY = 'lat-board-mic';

export interface MicOption {
	id: string;
	label: string;
}

/** The computer's microphones for the menu. The browser's own "default" and "communications"
 *  entries are left out (the menu's first item is the system default), and a microphone with no
 *  name yet (before the browser allows it) is numbered. */
export function micOptions(devices: readonly Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>[]): MicOption[] {
	const mics = devices.filter((device) => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications');
	return mics.map((device, index) => ({ id: device.deviceId, label: device.label.trim() || `麥克風 ${index + 1}` }));
}

/** True while some listed microphone has no name: the browser shows names (and may hide the id too) only once it allows the mic. */
export const unnamed = (devices: readonly Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>[]): boolean =>
	devices.some((device) => device.kind === 'audioinput' && !device.label);

/** What to ask `getUserMedia` for: the chosen microphone, or whichever the system uses. */
export function micConstraints(chosen: string | null): MediaStreamConstraints {
	return { audio: chosen ? { deviceId: { exact: chosen } } : true };
}

/** The chosen microphone is not there any more: the browser answers a request for it with this. */
export function micGone(error: unknown): boolean {
	const name = (error as { name?: string } | null)?.name;
	return name === 'OverconstrainedError' || name === 'NotFoundError';
}
