// A test device's terms as the page knows them, and the words it shows; the server checks the same
// rules on every request (server/test-device.ts).

export const TEST_DEVICE_NOT_OWNED = '測試裝置只能操作自己建立的 Agent';
export const TEST_DEVICE_DENIED = '測試裝置不能做這個動作';
/** The test device's whole rule, on its mark. */
export const TEST_DEVICE_RULE = '測試裝置：看得到全部，只能操作自己建立的 Agent；到期自動登出';

/** What `/api/device` answers: null for a device logged in with the password. */
export interface TestDeviceView {
	label: string;
	expiresAt: string;
	/** Session IDs of the agents and controllers it started. */
	owned: string[];
}
