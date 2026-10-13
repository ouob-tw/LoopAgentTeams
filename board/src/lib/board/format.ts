export const formatTime = (iso: string | null) =>
	iso === null ? '時間不明' : new Date(iso).toLocaleString('zh-TW', { hour12: false });
