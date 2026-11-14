// Whether this page can use the board's passkeys, and what the browser's refusal to make or use one
// means; shared by the login page and the settings. Browser only.
import { WebAuthnError } from '@simplewebauthn/browser';

/** Why this page cannot use the board's passkeys, which work only at `origin` (the board's
 *  address, null when it is not set); empty when it can. */
export function passkeyBlocked(origin: string | null): string {
	if (!origin) return '看板沒有設定網址（LAT_BOARD_URL），不能用 passkey。';
	if (!window.isSecureContext || location.origin !== origin) return `passkey 只能在 ${origin} 用。`;
	if (!window.PublicKeyCredential) return '這個瀏覽器不能用 passkey。';
	return '';
}

/** What the page says when this device already holds one of the board's passkeys. */
export const PASSKEY_ALREADY_HERE = '這個裝置已經有看板的 passkey，登入時直接用它。';

/** Whether the browser refused to make a passkey because this device already holds one of the
 *  board's (InvalidStateError, which @simplewebauthn names ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED). */
export function passkeyAlreadyHere(error: unknown): boolean {
	return (error instanceof WebAuthnError && error.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') || (error instanceof Error && error.name === 'InvalidStateError');
}

/** What the browser's own refusal to make (`making`) or use a passkey means. */
export function passkeyRefusal(error: unknown, making: boolean): string {
	if (making && passkeyAlreadyHere(error)) return PASSKEY_ALREADY_HERE;
	return making ? '沒有建立 passkey，請再按一次。' : '沒有完成 passkey，請再按一次。';
}

/** Where the page was when the browser refused: the second step after the password, a passkey
 *  alone, registering with the host's code, or registering from the settings. */
export type PasskeyFlow = 'second_step' | 'alone' | 'host_code' | 'settings';

/** Tell the server the browser refused, by the error's name only, for its log. Nothing waits for it
 *  and a failure to send is ignored. */
export function reportPasskeyRefusal(flow: PasskeyFlow, error: unknown): void {
	const name = error instanceof Error ? error.name : typeof error;
	void fetch('/api/login/passkey-error', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flow, name }) }).catch(() => {});
}
