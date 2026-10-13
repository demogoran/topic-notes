<script lang="ts">
	import type { LayoutProps } from './$types';
	import { api } from '#lib/client/api';
	import type { PublicUser } from '#lib/shared/types';

	let { data, children }: LayoutProps = $props();

	const user = $derived(data.user as PublicUser);

	async function logout() {
		await api.post('/api/auth/logout', {});
		window.location.href = '/login';
	}
</script>

<div class="shell">
	<header class="topbar">
		<div class="brand">🎙️ <span>VoiceNotes</span></div>
		<div class="account">
			<span class="email faint">{user.email}</span>
			<button class="avatar" onclick={logout} title="Sign out ({user.email})" aria-label="Sign out">
				{user.email[0]?.toUpperCase() ?? '?'}
			</button>
		</div>
	</header>

	<main class="content">
		{@render children()}
	</main>
</div>

<style>
	/* Fixed-height shell: the content area scrolls inside its own container,
	   so floating controls (bottom tab bar) always sit outside the content. */
	.shell {
		height: 100dvh;
		display: flex;
		flex-direction: column;
		max-width: 640px;
		margin: 0 auto;
		padding: 0 16px;
		overflow: hidden;
	}

	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: calc(12px + var(--safe-top)) 0 12px;
	}

	.brand {
		font-weight: 800;
		font-size: 17px;
		letter-spacing: -0.01em;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.account {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.email {
		font-size: 13px;
		max-width: 160px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.avatar {
		width: 34px;
		height: 34px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		font-weight: 700;
		font-size: 15px;
		color: #fff;
		background: linear-gradient(135deg, var(--accent), #6d28d9);
		flex-shrink: 0;
	}

	.content {
		flex: 1;
		min-height: 0; /* allows the flex child to shrink so overflow kicks in */
		overflow-y: auto;
		overflow-x: hidden;
		/* the container itself ends above the floating bottom tab bar —
		   content is clipped here and never renders behind the tabs */
		margin-bottom: calc(78px + var(--safe-bottom));
		padding-bottom: 16px;
		scrollbar-width: thin;
		overscroll-behavior: contain;
	}

	.content::-webkit-scrollbar {
		width: 6px;
	}

	.content::-webkit-scrollbar-thumb {
		background: var(--line-strong);
		border-radius: 3px;
	}

	@media (max-width: 480px) {
		.email {
			display: none;
		}
	}
</style>
