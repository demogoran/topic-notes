<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ApiError } from '#lib/client/api';

	interface Props {
		mode: 'login' | 'register';
		onsubmit: (email: string, password: string) => Promise<void>;
		footer?: Snippet;
	}

	let { mode, onsubmit, footer }: Props = $props();

	let email = $state('');
	let password = $state('');
	let busy = $state(false);
	let errorText = $state('');
	let fieldErrors = $state<Record<string, string>>({});

	const isLogin = $derived(mode === 'login');

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;
		busy = true;
		errorText = '';
		fieldErrors = {};
		try {
			await onsubmit(email, password);
		} catch (err) {
			if (err instanceof ApiError) {
				errorText = err.message;
				fieldErrors = err.fieldErrors;
			} else {
				errorText = 'Something went wrong. Please try again.';
			}
		} finally {
			busy = false;
		}
	}
</script>

<form class="auth-card card" onsubmit={handleSubmit}>
	<h2>{isLogin ? 'Welcome back' : 'Create your account'}</h2>
	<p class="muted sub">{isLogin ? 'Sign in to your voice notes.' : 'Email + password. No verification needed.'}</p>

	<div class="field">
		<label class="label" for="email">Email</label>
		<input
			id="email"
			type="email"
			autocomplete="email"
			placeholder="you@example.com"
			required
			bind:value={email}
		/>
		{#if fieldErrors.email}<p class="error-text">{fieldErrors.email}</p>{/if}
	</div>

	<div class="field">
		<label class="label" for="password">Password</label>
		<input
			id="password"
			type="password"
			autocomplete={isLogin ? 'current-password' : 'new-password'}
			placeholder={isLogin ? 'Your password' : 'At least 8 characters'}
			required
			bind:value={password}
		/>
		{#if fieldErrors.password}<p class="error-text">{fieldErrors.password}</p>{/if}
	</div>

	{#if errorText}<p class="error-text" role="alert">{errorText}</p>{/if}

	<button class="btn btn-primary submit" type="submit" disabled={busy}>
		{#if busy}<span class="spinner"></span>{/if}
		{isLogin ? 'Sign in' : 'Create account'}
	</button>

	{#if footer}{@render footer()}{/if}
</form>

<style>
	.auth-card {
		width: 100%;
		max-width: 380px;
		padding: 24px 20px;
		animation: rise 0.4s ease both;
	}

	h2 {
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	.sub {
		font-size: 14px;
		margin: 4px 0 20px;
	}

	.submit {
		width: 100%;
		margin-top: 6px;
	}
</style>
