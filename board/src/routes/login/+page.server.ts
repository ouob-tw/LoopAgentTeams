import { getBoard } from '#lib/server/board.ts';
import { secondSteps } from '#lib/server/login-steps.ts';
import { hasPassword } from '#lib/server/password.ts';

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
	const { stateDir } = getBoard().config;
	return {
		password: setting(() => hasPassword(stateDir), '看板密碼檔'),
		secondStep: setting(() => secondSteps(stateDir).length > 0, '看板第二道驗證的設定檔')
	};
};
