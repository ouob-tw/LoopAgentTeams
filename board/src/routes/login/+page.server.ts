import { getBoard } from '#lib/server/board.ts';
import { hasPasskeys } from '#lib/server/passkeys.ts';
import { hasPassword } from '#lib/server/password.ts';
import { hasTotp } from '#lib/server/totp.ts';

/** Whether a login setting is there, by reading its file; `file` names it in the log. */
function setting(isSet: () => boolean, file: string): 'set' | 'unset' | 'unreadable' {
	try {
		return isSet() ? 'set' : 'unset';
	} catch (error) {
		console.error(`${file}讀不出來：${(error as Error).message}`);
		return 'unreadable';
	}
}

export const load = () => {
	const { stateDir, passkeySite } = getBoard().config;
	return {
		password: setting(() => hasPassword(stateDir), '看板密碼檔'),
		totp: setting(() => hasTotp(stateDir), '看板 TOTP 金鑰檔'),
		passkeys: setting(() => hasPasskeys(stateDir), '看板 passkey 檔'),
		/** The only address passkeys work from; null when the board's address is not set. */
		passkeyOrigin: passkeySite?.origin ?? null
	};
};
