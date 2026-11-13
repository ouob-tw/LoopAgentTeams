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

/** What the browser's own refusal to make (`making`) or use a passkey means. */
export function passkeyRefusal(error: unknown, making: boolean): string {
	if (error instanceof WebAuthnError && error.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return '這個裝置已經登記過看板的 passkey。';
	return making ? '沒有建立 passkey，請再按一次。' : '沒有完成 passkey，請再按一次。';
}
