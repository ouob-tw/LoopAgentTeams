import { json } from '@sveltejs/kit';
import type { TestDeviceView } from '#lib/board/test-device.ts';
import type { RequestHandler } from './$types';

/** This device's test login terms, with the agents it started so far; null for a password device. */
export const GET: RequestHandler = ({ locals }) => {
	const test = locals.device?.test;
	const view: TestDeviceView | null = test ? { label: test.label, expiresAt: test.expiresAt, owned: test.owned } : null;
	return json({ test: view });
};
