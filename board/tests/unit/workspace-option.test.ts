// The launch forms' Herdr workspace field: where each form starts, the new workspace's name, and
// what the field sends.
import { expect, test } from 'bun:test';
import { defaultWorkspaceOption, newWorkspaceName, workspaceToSend } from '../../src/lib/board/launch.ts';

test('the new-agent form starts in its own workspace, a new controller automatically', () => {
	expect(defaultWorkspaceOption('wA')).toEqual({ kind: 'current' });
	expect(defaultWorkspaceOption(null)).toEqual({ kind: 'auto' });
});

test('a new workspace is named after the folder until the name is typed, an emptied name included', () => {
	expect(newWorkspaceName(null, '/srv/projects/alpha')).toBe('alpha');
	expect(newWorkspaceName(null, '/srv/projects/alpha/')).toBe('alpha');
	expect(newWorkspaceName(null, null)).toBe('');
	expect(newWorkspaceName('我的區', '/srv/projects/alpha')).toBe('我的區');
	expect(newWorkspaceName('', '/srv/projects/alpha')).toBe('');
});

test('each option sends its own choice; nothing is sent for a new workspace without a name', () => {
	expect(workspaceToSend({ kind: 'current' }, 'wA', '')).toEqual({ kind: 'existing', id: 'wA' });
	expect(workspaceToSend({ kind: 'current' }, null, '')).toBeNull();
	expect(workspaceToSend({ kind: 'auto' }, 'wA', 'x')).toEqual({ kind: 'auto' });
	expect(workspaceToSend({ kind: 'existing', id: 'wE' }, 'wA', 'x')).toEqual({ kind: 'existing', id: 'wE' });
	expect(workspaceToSend({ kind: 'new' }, 'wA', ' 新區 ')).toEqual({ kind: 'new', label: '新區' });
	expect(workspaceToSend({ kind: 'new' }, 'wA', '  ')).toBeNull();
});
