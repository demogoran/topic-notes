<script lang="ts">
	import { goto } from '$app/navigation';
	import { api } from '#lib/client/api';
	import AuthForm from '#lib/components/AuthForm.svelte';

	async function register(email: string, password: string) {
		await api.post('/api/auth/register', { email, password });
		await goto('/app', { invalidateAll: true });
	}
</script>

<svelte:head>
	<title>Create account · VoiceNotes</title>
</svelte:head>

<AuthForm mode="register" onsubmit={register}>
	{#snippet footer()}
		<p class="switch muted">Already have an account? <a href="/login">Sign in</a></p>
	{/snippet}
</AuthForm>

<style>
	.switch {
		margin-top: 16px;
		font-size: 14px;
		text-align: center;
	}
</style>
