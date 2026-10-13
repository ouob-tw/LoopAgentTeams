<script lang="ts">
	let code = $state('');
	let failed = $state(false);
	let sending = $state(false);

	async function pair(event: SubmitEvent) {
		event.preventDefault();
		sending = true;
		try {
			const response = await fetch('/api/pair', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ code })
			});
			if (response.ok) return void (location.href = '/');
		} catch {
			// Shown as a failed attempt below.
		}
		failed = true;
		sending = false;
	}
</script>

<main>
	<h1>LAT 看板</h1>
	<p>這台裝置還沒有配對。請在主機上執行配對指令，再把顯示的配對碼輸入這裡。</p>
	<form onsubmit={pair}>
		<label for="code">配對碼</label>
		<input id="code" bind:value={code} autocomplete="off" autocapitalize="characters" spellcheck="false" required />
		<button class="primary" disabled={sending || !code.trim()}>配對</button>
	</form>
	{#if failed}
		<p class="failed" role="alert">配對失敗：配對碼不正確、已經用過或已過期。請在主機上重新產生一組。</p>
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
		font-family: var(--mono);
		letter-spacing: 0.1em;
	}
	.failed {
		color: var(--danger);
	}
</style>
