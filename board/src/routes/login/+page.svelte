<script lang="ts">
	let { data } = $props();

	const SET_COMMAND = 'bun run board password';

	let password = $state('');
	let failure = $state('');
	let sending = $state(false);
	let waitUntil = $state(0);
	let now = $state(Date.now());
	let waitLeft = $derived(Math.max(0, Math.ceil((waitUntil - now) / 1000)));

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

	function lockedFor(seconds: number) {
		now = Date.now();
		waitUntil = now + seconds * 1000;
	}

	async function login(event: SubmitEvent) {
		event.preventDefault();
		if (sending || waitLeft || !password) return;
		sending = true;
		try {
			const response = await fetch('/api/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ password })
			});
			if (response.ok) return void (location.href = '/');
			const body = await response.json().catch(() => ({}));
			password = '';
			if (response.status === 429) {
				lockedFor(Number(body.retryAfterSeconds) || 60);
				failure = '密碼連續輸錯太多次，請稍候再試。';
			} else if (response.status === 401) failure = '密碼不正確。';
			else if (response.status === 409) failure = `還沒設定密碼，請先在主機上執行 ${SET_COMMAND}。`;
			else failure = `登入失敗：看板伺服器回報錯誤（${response.status}）。`;
		} catch {
			failure = '登入失敗：連不上看板伺服器。';
		}
		sending = false;
	}

	// Enter that picks a candidate in an input method must not send the form.
	function keydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault();
	}
</script>

<main>
	<h1>LAT 看板</h1>
	{#if data.passwordSet}
		<p>請輸入看板密碼。</p>
		<form onsubmit={login}>
			<label for="password">密碼</label>
			<input
				id="password"
				type="password"
				bind:value={password}
				onkeydown={keydown}
				autocomplete="current-password"
				required
			/>
			<button class="primary" disabled={sending || waitLeft > 0 || !password}>登入</button>
		</form>
		{#if failure}
			<p class="failed" role="alert">
				{failure}{#if waitLeft}請等 {waitLeft} 秒。{/if}
			</p>
		{/if}
	{:else}
		<p>看板還沒設定密碼，目前無法登入。請在主機上的看板目錄執行：</p>
		<pre><code>{SET_COMMAND}</code></pre>
		<p>設定好之後重新載入這個畫面。</p>
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
		font-size: 1.3rem;
	}
	form {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: center;
	}
	input {
		flex: 1;
		min-width: 10rem;
	}
	pre {
		overflow-x: auto;
		padding: 0.6rem 0.8rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		font-family: var(--mono);
	}
	.failed {
		color: var(--danger);
	}
</style>
