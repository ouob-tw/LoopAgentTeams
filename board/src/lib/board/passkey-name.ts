/** A passkey's name in the settings: the system and browser it was registered from, read from the
 *  browser's user agent then. */
export function passkeyName(userAgent: string): string {
	const system = [
		[/iPhone/, 'iPhone'],
		[/iPad/, 'iPad'],
		[/Android/, 'Android'],
		[/CrOS/, 'ChromeOS'],
		[/Macintosh|Mac OS X/, 'Mac'],
		[/Windows/, 'Windows'],
		[/Linux/, 'Linux']
	] as const;
	const browser = [
		[/Edg[A-Z]*\//, 'Edge'],
		[/Firefox\/|FxiOS\//, 'Firefox'],
		[/Chrome\/|CriOS\//, 'Chrome'],
		[/Safari\//, 'Safari']
	] as const;
	const first = (list: readonly (readonly [RegExp, string])[]) => list.find(([pattern]) => pattern.test(userAgent))?.[1];
	return [first(system), first(browser)].filter(Boolean).join(' · ') || '不明的瀏覽器';
}
