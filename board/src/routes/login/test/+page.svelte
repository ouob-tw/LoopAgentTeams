<script lang="ts">
	import { onMount } from 'svelte';
	import { hostCommand } from '#lib/host-command.ts';

	let { data } = $props();

	// The one-time code rides in the link's fragment, which the browser never sends to a server, so
	// no log or link preview can use it up: only this button does.
	let code = $state('');
	let failure = $state('');
	let sending = $state(false);

	onMount(() => {
		code = location.hash.slice(1);
		// Out of the address bar and the history, once read.
		history.replaceState(history.state, '', location.pathname);
	});

	async function login() {
		if (sending || !code) return;
		sending = true;
		try {
			const response = await fetch('/api/login/test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ code })
			});
			if (response.ok) return void (location.href = '/');
			failure = response.status === 401 ? '這個測試登入網址已經用過或已到期，請向主機要一個新的。' : `登入失敗：看板伺服器回報錯誤（${response.status}）。`;
		} catch {
			failure = '登入失敗：連不上看板伺服器。';
		}
		sending = false;
	}
</script>

<main>
	<h1>LAT 看板・測試登入</h1>
	{#if code}
		<p>這台瀏覽器會成為<strong>測試裝置</strong>：看得到全部，只能操作自己建立的 Agent，到期自動登出。</p>
		<button class="primary" onclick={login} disabled={sending}>以測試裝置登入</button>
	{:else if !failure}
		<p>這個網址缺少登入碼。請用主機上 <code>{hostCommand(data.boardDir, 'test-login')}</code> 印出的完整網址。</p>
	{/if}
	{#if failure}
		<p class="failed" role="alert">{failure}</p>
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
	.failed {
		color: var(--danger);
	}
</style>
