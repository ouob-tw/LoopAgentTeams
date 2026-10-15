export const formatTime = (iso: string | null) =>
	iso === null
		? '時間不明'
		: new Date(iso).toLocaleString('zh-TW', {
				month: 'numeric',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit',
				hour12: false
			});
