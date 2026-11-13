<script lang="ts">
	import { Check, KeyRound, TriangleAlert } from '@lucide/svelte';
	import { startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser';
	import { onMount, tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	const SET_COMMAND = 'bun run board password';
	const TOTP_COMMAND = 'bun run board totp';
	const ENROLL_COMMAND = 'bun run board passkey code';

	/** Logging in, or registering a passkey. */
	let mode = $state<'login' | 'enroll'>('login');
	let step = $state<'password' | 'code'>('password');
	/** The second step this browser uses: a passkey, or the TOTP code. */
	let method = $state<'passkey' | 'totp'>('totp');
	/** The second steps the right password opened. */
	let offered = $state<string[]>([]);
	let password = $state('');
	let code = $state('');
	let enrollCode = $state('');
	let input = $state<HTMLInputElement>();
	let codeInput = $state<HTMLInputElement>();
	let passkeyButton = $state<HTMLButtonElement>();
	let failure = $state('');
	let notice = $state('');
	let sending = $state(false);
	let waitUntil = $state(0);
	let now = $state(Date.now());
	let waitLeft = $derived(Math.max(0, Math.ceil((waitUntil - now) / 1000)));
	/** When the open second step ends: the browser goes back to the password then. */
	let codeUntil = $state(0);
	/** Why this page cannot use a passkey; empty when it can. Known once the page runs in the browser. */
	let passkeyBlocked = $state('');
	let checked = $state(false);

	onMount(() => {
		if (!data.passkeyOrigin) passkeyBlocked = '看板沒有設定網址（LAT_BOARD_URL），不能用 passkey。';
		else if (!window.isSecureContext || location.origin !== data.passkeyOrigin) passkeyBlocked = `passkey 只能在 ${data.passkeyOrigin} 用。`;
		else if (!window.PublicKeyCredential) passkeyBlocked = '這個瀏覽器不能用 passkey。';
		checked = true;
	});

	let passkeyHere = $derived(checked && !passkeyBlocked);
	/** Registered passkeys this page cannot use, and no TOTP to fall back on: no login from here. */
	let stranded = $derived(checked && !passkeyHere && data.passkeys === 'set' && data.totp !== 'set');
	/** The second step the page expects before the password is in, then the one in use. */
	let secondLabel = $derived(
		(step === 'code' ? method === 'passkey' : data.passkeys === 'set' && passkeyHere) ? 'passkey' : '驗證碼'
	);

	$effect(() => {
		if (!waitUntil) return;
		const timer = setInterval(() => {
			now = Date.now();
			if (now >= waitUntil) {
				waitUntil = 0;
				failure = '';
			}
		}, 250);
		return () => clearInterval(timer);
	});

	$effect(() => {
		if (!codeUntil) return;
		const timer = setTimeout(() => backToPassword(TIMED_OUT), Math.max(0, codeUntil - Date.now()));
		return () => clearTimeout(timer);
	});

	const TIMED_OUT = '超過 5 分鐘沒完成第二步，請重新輸入密碼。';

	function lockedFor(seconds: number) {
		now = Date.now();
		waitUntil = now + seconds * 1000;
	}

	function syncFromBox() {
		if (input) ({ value: password } = input);
	}

	function backToPassword(message = '') {
		mode = 'login';
		step = 'password';
		code = '';
		codeUntil = 0;
		failure = message;
		void tick().then(() => input?.focus());
	}

	/** What the server's refusal means to the person at the screen. */
	async function refused(response: Response): Promise<string> {
		const body = await response.json().catch(() => ({}));
		if (response.status === 429) {
			lockedFor(Number(body.retryAfterSeconds) || 60);
			return '輸錯太多次，請稍候再試。';
		}
		if (body.error === 'wrong_password') return '密碼不正確。';
		if (body.error === 'wrong_code') return '驗證碼不正確，請輸入 App 上現在顯示的數字。';
		if (body.error === 'passkey_failed') return mode === 'enroll' ? '沒有建立 passkey，請再試一次。' : 'passkey 驗證沒有通過，請再試一次。';
		if (body.error === 'wrong_enroll_code') return '登記碼不對或已失效，請在主機上產生新的登記碼。';
		if (body.error === 'enroll_expired') return '超過 5 分鐘沒建立 passkey，請重新輸入。';
		if (body.error === 'second_step_expired') {
			backToPassword(TIMED_OUT);
			return TIMED_OUT;
		}
		if (body.error === 'password_unreadable') return `登入失敗：看板的密碼檔讀不出來，請在主機上重新執行 ${SET_COMMAND}。`;
		if (body.error === 'no_password') return `還沒設定密碼，請先在主機上執行 ${SET_COMMAND}。`;
		if (body.error === 'no_second_step') return `還沒設定第二道驗證，請先在主機上執行 ${TOTP_COMMAND}。`;
		if (body.error === 'second_step_unreadable') return `登入失敗：TOTP 金鑰檔讀不出來，請在主機上重新執行 ${TOTP_COMMAND}。`;
		if (body.error === 'passkeys_unreadable') return '失敗：看板的 passkey 檔讀不出來，請看主機上看板的紀錄。';
		if (body.error === 'passkey_unavailable') return '看板沒有設定網址（LAT_BOARD_URL），不能用 passkey。';
		if (body.error === 'no_passkey') return '看板上已經沒有登記的 passkey，請改用驗證碼。';
		return `失敗：看板伺服器回報錯誤（${response.status}）。`;
	}

	async function send(path: string, body: object): Promise<Response | null> {
		try {
			return await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		} catch {
			failure = '失敗：連不上看板伺服器。';
			return null;
		}
	}

	/** What the browser's own refusal to make or use a passkey means. */
	function browserRefused(error: unknown): string {
		if (error instanceof WebAuthnError && error.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return '這個裝置已經登記過看板的 passkey。';
		return mode === 'enroll' ? '沒有建立 passkey，請再按一次。' : '沒有完成 passkey，請再按一次。';
	}

	async function login(event: SubmitEvent) {
		event.preventDefault();
		// A password manager can fill the box without an input event; what counts is what is in it.
		syncFromBox();
		if (sending || waitLeft || !password) return;
		sending = true;
		const response = await send('/api/login', { password });
		password = '';
		if (response?.ok) {
			const { secondsLeft, secondStep } = await response.json();
			offered = Array.isArray(secondStep) ? secondStep : ['totp'];
			method = offered.includes('passkey') && passkeyHere ? 'passkey' : 'totp';
			step = 'code';
			failure = '';
			notice = '';
			codeUntil = Date.now() + (Number(secondsLeft) || 300) * 1000;
			// Before the focus: a disabled button cannot take it.
			sending = false;
			await tick();
			(method === 'passkey' ? passkeyButton : codeInput)?.focus();
			return;
		}
		if (response) failure = await refused(response);
		sending = false;
	}

	async function confirm(event: SubmitEvent) {
		event.preventDefault();
		if (codeInput) ({ value: code } = codeInput);
		if (sending || waitLeft || !code.trim()) return;
		sending = true;
		const response = await send('/api/login/totp', { code });
		if (response?.ok) return void (location.href = '/');
		code = '';
		if (response) failure = await refused(response);
		sending = false;
		codeInput?.focus();
	}

	async function usePasskey() {
		if (sending || waitLeft) return;
		sending = true;
		failure = '';
		const options = await send('/api/login/passkey/options', {});
		if (!options?.ok) {
			if (options) failure = await refused(options);
			sending = false;
			return;
		}
		let answer;
		try {
			answer = await startAuthentication({ optionsJSON: await options.json() });
		} catch (error) {
			failure = browserRefused(error);
			sending = false;
			return;
		}
		const response = await send('/api/login/passkey', { response: answer });
		if (response?.ok) return void (location.href = '/');
		if (response) failure = await refused(response);
		sending = false;
	}

	async function switchTo(next: 'passkey' | 'totp') {
		method = next;
		failure = '';
		await tick();
		(next === 'passkey' ? passkeyButton : codeInput)?.focus();
	}

	async function openEnroll() {
		mode = 'enroll';
		step = 'password';
		codeUntil = 0;
		failure = '';
		notice = '';
		await tick();
		input?.focus();
	}

	async function enroll(event: SubmitEvent) {
		event.preventDefault();
		syncFromBox();
		if (sending || waitLeft || !password || !enrollCode.trim()) return;
		sending = true;
		failure = '';
		const started = await send('/api/login/enroll/options', { password, code: enrollCode });
		if (!started?.ok) {
			if (started) failure = await refused(started);
			sending = false;
			return;
		}
		const { options, enrollment } = await started.json();
		let created;
		try {
			created = await startRegistration({ optionsJSON: options });
		} catch (error) {
			failure = browserRefused(error);
			sending = false;
			return;
		}
		const response = await send('/api/login/enroll', { enrollment, response: created });
		if (response?.ok) {
			password = '';
			enrollCode = '';
			// The page's settings now have a passkey: the second step it expects is the passkey.
			await invalidateAll();
			backToPassword();
			notice = '已登記 passkey，現在可以登入。';
		} else if (response) failure = await refused(response);
		sending = false;
	}

	// Enter that picks a candidate in an input method must not send the form.
	function keydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault();
	}
</script>

{#snippet blockedNote()}
	<p class="blocked"><TriangleAlert size="1em" aria-hidden="true" />{passkeyBlocked}</p>
{/snippet}

{#snippet passwordBox()}
	<label for="password">密碼</label>
	<input
		id="password"
		type="password"
		bind:value={password}
		bind:this={input}
		onkeydown={keydown}
		autocomplete="current-password"
		required
	/>
{/snippet}

<main>
	<h1>{mode === 'enroll' ? '登記 passkey' : 'LAT 看板'}</h1>
	{#if data.password !== 'set'}
		<p>
			{data.password === 'unset' ? '看板還沒設定密碼' : '看板的密碼檔讀不出來'}，目前無法登入。請在主機上的看板目錄執行：
		</p>
		<pre><code>{SET_COMMAND}</code></pre>
		<p>設定好之後重新載入這個畫面。</p>
	{:else if mode === 'enroll'}
		{#if !checked}
			<!-- The browser has not said yet whether this page can make a passkey. -->
		{:else if passkeyBlocked}
			{@render blockedNote()}
		{:else}
			<form onsubmit={enroll}>
				{@render passwordBox()}
				<label for="enroll-code">登記碼<span class="hint">（主機上執行 <code>{ENROLL_COMMAND}</code>）</span></label>
				<input
					id="enroll-code"
					class="code"
					bind:value={enrollCode}
					onkeydown={keydown}
					autocomplete="off"
					autocapitalize="characters"
					spellcheck="false"
					required
				/>
				<button class="primary" disabled={sending || waitLeft > 0}>建立 passkey</button>
			</form>
		{/if}
		{#if failure}
			<p class="failed" role="alert">
				{failure}{#if waitLeft}請等 {waitLeft} 秒。{/if}
			</p>
		{/if}
		<button class="back" type="button" onclick={() => backToPassword()}>返回登入</button>
	{:else if data.totp === 'unreadable' || data.passkeys === 'unreadable'}
		<p>
			{data.totp === 'unreadable' ? '看板的 TOTP 金鑰檔讀不出來' : '看板的 passkey 檔讀不出來'}，目前無法登入。請在主機上的看板目錄執行：
		</p>
		<pre><code>{data.totp === 'unreadable' ? TOTP_COMMAND : 'bun run board passkey list'}</code></pre>
		<p>依它的訊息修好之後重新載入這個畫面。</p>
	{:else if data.totp !== 'set' && data.passkeys !== 'set'}
		<p>看板還沒設定第二道驗證，目前無法登入。請在主機上的看板目錄執行：</p>
		<pre><code>{TOTP_COMMAND}</code></pre>
		<p>用手機的驗證器 App 掃描它顯示的 QR code，設定好之後重新載入這個畫面。</p>
		{#if data.passkeyOrigin}
			<button class="back" type="button" onclick={openEnroll}>改為登記 passkey</button>
		{/if}
	{:else if stranded}
		{@render blockedNote()}
	{:else}
		<ol class="steps" aria-label="登入步驟">
			<li class:done={step === 'code'} aria-current={step === 'password' ? 'step' : undefined}>
				<span class="mark">{#if step === 'code'}<Check size="0.9em" aria-label="已完成" />{:else}1{/if}</span>密碼
			</li>
			<li class:todo={step === 'password'} aria-current={step === 'code' ? 'step' : undefined}>
				<span class="mark">2</span>{secondLabel}
			</li>
		</ol>
		{#if step === 'password'}
			<form onsubmit={login}>
				{@render passwordBox()}
				<!-- Not disabled for an empty box: an autofilled password may not have reached `password`
				     yet, and `required` already stops an empty submit. -->
				<button class="primary" disabled={sending || waitLeft > 0}>下一步</button>
			</form>
		{:else if method === 'passkey'}
			<button class="primary passkey" type="button" bind:this={passkeyButton} onclick={usePasskey} disabled={sending || waitLeft > 0}>
				<KeyRound size="1.1em" aria-hidden="true" />使用 passkey
			</button>
		{:else}
			{#if offered.includes('passkey') && passkeyBlocked}
				{@render blockedNote()}
			{/if}
			<form onsubmit={confirm}>
				<label for="code">驗證器 App 上的六位數字</label>
				<input
					id="code"
					class="code"
					bind:value={code}
					bind:this={codeInput}
					onkeydown={keydown}
					inputmode="numeric"
					autocomplete="one-time-code"
					maxlength="7"
					required
				/>
				<button class="primary" disabled={sending || waitLeft > 0}>登入</button>
			</form>
		{/if}
		{#if notice && !failure}
			<p class="notice" role="status"><Check size="1em" aria-hidden="true" />{notice}</p>
		{/if}
		{#if failure}
			<p class="failed" role="alert">
				{failure}{#if waitLeft}請等 {waitLeft} 秒。{/if}
			</p>
		{/if}
		<div class="links">
			{#if step === 'code'}
				{#if method === 'passkey' && offered.includes('totp')}
					<button class="back" type="button" onclick={() => switchTo('totp')}>改用驗證碼</button>
				{:else if method === 'totp' && offered.includes('passkey') && passkeyHere}
					<button class="back" type="button" onclick={() => switchTo('passkey')}>改用 passkey</button>
				{/if}
				<button class="back" type="button" onclick={() => backToPassword()}>重新輸入密碼</button>
			{:else if data.passkeyOrigin}
				<button class="back" type="button" onclick={openEnroll}>登記 passkey</button>
			{/if}
		</div>
	{/if}
</main>

<style>
	main {
		max-width: 26rem;
		margin: 15vh auto 0;
		padding: 1rem;
	}
	h1 {
		margin: 0 0 0.5rem;
		font-size: max(1.3rem, var(--min-font, 0px));
	}
	.steps {
		display: flex;
		gap: 1.2rem;
		margin: 0 0 0.9rem;
		padding: 0;
		list-style: none;
	}
	.steps li {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		font-weight: 600;
	}
	.steps li.todo,
	.steps li.done {
		color: var(--muted);
		font-weight: normal;
	}
	.mark {
		display: inline-grid;
		place-items: center;
		width: 1.5em;
		height: 1.5em;
		border: 1px solid currentColor;
		border-radius: 50%;
		font-size: 0.85em;
	}
	li[aria-current='step'] .mark {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--bg);
	}
	.done .mark {
		border-color: var(--ok);
		color: var(--ok);
	}
	form {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: center;
	}
	label {
		flex-basis: 100%;
	}
	/* The registration form has two boxes: each takes its own line, with the button under them. */
	form:has(#enroll-code) input {
		flex-basis: 100%;
	}
	.hint {
		color: var(--muted);
		font-size: 0.9em;
	}
	input {
		flex: 1;
		min-width: 10rem;
	}
	.code {
		font-family: var(--mono);
		letter-spacing: 0.2em;
	}
	.passkey {
		display: inline-flex;
		gap: 0.5rem;
		align-items: center;
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1.2rem;
		margin-top: 0.8rem;
	}
	.back {
		padding: 0;
		border: none;
		background: none;
		color: var(--accent);
		text-decoration: underline;
		cursor: pointer;
	}
	main > .back {
		margin-top: 0.8rem;
	}
	.blocked,
	.notice {
		display: flex;
		gap: 0.4rem;
		align-items: baseline;
	}
	.blocked {
		color: var(--muted);
	}
	.blocked :global(svg),
	.notice :global(svg) {
		flex: none;
		align-self: center;
	}
	.notice {
		margin-bottom: 0;
		color: var(--ok);
	}
	pre {
		overflow-x: auto;
		padding: 0.6rem 0.8rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		font-family: var(--mono);
	}
	.failed {
		margin-bottom: 0;
		color: var(--danger);
	}
</style>
