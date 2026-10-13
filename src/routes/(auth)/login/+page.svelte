<script lang="ts">
	import { goto } from '$app/navigation';
	import { api } from '#lib/client/api';
	import AuthForm from '#lib/components/AuthForm.svelte';

	async function login(email: string, password: string) {
		await api.post('/api/auth/login', { email, password });
		await goto('/app', { invalidateAll: true });
	}
</script>

<svelte:head>
	<title>Sign in · VoiceNotes</title>
</svelte:head>

<AuthForm mode="login" onsubmit={login}>
	{#snippet footer()}
		<p class="switch muted">No account yet? <a href="/register">Create one</a></p>
	{/snippet}
</AuthForm>

<style>
	.switch {
		margin-top: 16px;
		font-size: 14px;
		text-align: center;
	}
</style>
