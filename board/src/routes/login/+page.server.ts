import { getBoard } from '#lib/server/board.ts';
import { hasPassword } from '#lib/server/password.ts';

export const load = () => {
	try {
		return { password: hasPassword(getBoard().config.stateDir) ? 'set' : 'unset' } as const;
	} catch (error) {
		console.error(`看板密碼檔讀不出來：${(error as Error).message}`);
		return { password: 'unreadable' } as const;
	}
};
