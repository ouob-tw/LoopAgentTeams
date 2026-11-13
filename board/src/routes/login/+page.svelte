<script lang="ts">
	import { Check } from '@lucide/svelte';
	import { tick } from 'svelte';

	let { data } = $props();

	const SET_COMMAND = 'bun run board password';
	const TOTP_COMMAND = 'bun run board totp';

	let step = $state<'password' | 'code'>('password');
	let password = $state('');
	let code = $state('');
	let input = $state<HTMLInputElement>();
	let codeInput = $state<HTMLInputElement>();
	let failure = $state('');
	let sending = $state(false);
	let waitUntil = $state(0);
	let now = $state(Date.now());
	let waitLeft = $derived(Math.max(0, Math.ceil((waitUntil - now) / 1000)));
	/** When the open second step ends: the browser goes back to the password then. */
	let codeUntil = $state(0);

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

	const TIMED_OUT = '超過 5 分鐘沒輸入驗證碼，請重新輸入密碼。';

	function lockedFor(seconds: number) {
		now = Date.now();
		waitUntil = now + seconds * 1000;
	}

	function syncFromBox() {
		if (input) ({ value: password } = input);
	}

	function backToPassword(message = '') {
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
		if (body.error === 'second_step_expired') {
			backToPassword(TIMED_OUT);
			return TIMED_OUT;
		}
		if (body.error === 'password_unreadable') return `登入失敗：看板的密碼檔讀不出來，請在主機上重新執行 ${SET_COMMAND}。`;
		if (body.error === 'no_password') return `還沒設定密碼，請先在主機上執行 ${SET_COMMAND}。`;
		if (body.error === 'no_second_step') return `還沒設定第二道驗證，請先在主機上執行 ${TOTP_COMMAND}。`;
		if (body.error === 'second_step_unreadable') return `登入失敗：TOTP 金鑰檔讀不出來，請在主機上重新執行 ${TOTP_COMMAND}。`;
		return `登入失敗：看板伺服器回報錯誤（${response.status}）。`;
	}

	async function send(path: string, body: object): Promise<Response | null> {
		try {
			return await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		} catch {
			failure = '登入失敗：連不上看板伺服器。';
			return null;
		}
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
			const { secondsLeft } = await response.json();
			step = 'code';
			failure = '';
			codeUntil = Date.now() + (Number(secondsLeft) || 300) * 1000;
			await tick();
			codeInput?.focus();
		} else if (response) failure = await refused(response);
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

	// Enter that picks a candidate in an input method must not send the form.
	function keydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault();
	}
</script>

<main>
	<h1>LAT 看板</h1>
	{#if data.password !== 'set'}
		<p>
			{data.password === 'unset' ? '看板還沒設定密碼' : '看板的密碼檔讀不出來'}，目前無法登入。請在主機上的看板目錄執行：
		</p>
		<pre><code>{SET_COMMAND}</code></pre>
		<p>設定好之後重新載入這個畫面。</p>
	{:else if data.secondStep !== 'set'}
		<p>
			{data.secondStep === 'unset' ? '看板還沒設定第二道驗證' : '看板的 TOTP 金鑰檔讀不出來'}，目前無法登入。請在主機上的看板目錄執行：
		</p>
		<pre><code>{TOTP_COMMAND}</code></pre>
		<p>用手機的驗證器 App 掃描它顯示的 QR code，設定好之後重新載入這個畫面。</p>
	{:else}
		<ol class="steps" aria-label="登入步驟">
			<li class:done={step === 'code'} aria-current={step === 'password' ? 'step' : undefined}>
				<span class="mark">{#if step === 'code'}<Check size="0.9em" aria-label="已完成" />{:else}1{/if}</span>密碼
			</li>
			<li class:todo={step === 'password'} aria-current={step === 'code' ? 'step' : undefined}>
				<span class="mark">2</span>驗證碼
			</li>
		</ol>
		{#if step === 'password'}
			<form onsubmit={login}>
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
				<!-- Not disabled for an empty box: an autofilled password may not have reached `password`
				     yet, and `required` already stops an empty submit. -->
				<button class="primary" disabled={sending || waitLeft > 0}>下一步</button>
			</form>
		{:else}
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
		{#if failure}
			<p class="failed" role="alert">
				{failure}{#if waitLeft}請等 {waitLeft} 秒。{/if}
			</p>
		{/if}
		{#if step === 'code'}
			<button class="back" type="button" onclick={() => backToPassword()}>重新輸入密碼</button>
		{/if}
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
	input {
		flex: 1;
		min-width: 10rem;
	}
	.code {
		font-family: var(--mono);
		letter-spacing: 0.2em;
	}
	.back {
		margin-top: 0.8rem;
		padding: 0;
		border: none;
		background: none;
		color: var(--accent);
		text-decoration: underline;
		cursor: pointer;
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
