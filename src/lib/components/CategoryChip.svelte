<script lang="ts">
	interface Props {
		name: string;
		selected?: boolean;
		dimmed?: boolean;
		onclick?: () => void;
		/** Reduced padding/font — used for per-task tags inside checklists. */
		small?: boolean;
	}

	let { name, selected = false, dimmed = false, small = false, onclick }: Props = $props();
</script>

<button class="chip cat-chip" class:small {onclick} style={chipStyle(name, selected)} class:dimmed>
	{name}
</button>

<script lang="ts" module>
	function chipStyle(name: string, selected: boolean): string {
		const hue = categoryHue(name);
		return selected
			? `background:hsl(${hue} 60% 62% / 0.22);border-color:hsl(${hue} 70% 65% / 0.6);color:hsl(${hue} 85% 82%)`
			: `background:hsl(${hue} 40% 60% / 0.08);border-color:hsl(${hue} 40% 60% / 0.25);color:hsl(${hue} 55% 74%)`;
	}

	function categoryHue(name: string): number {
		let h = 0;
		for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
		return h % 360;
	}
</script>

<style>
	.cat-chip {
		border-width: 1px;
		transition: opacity 0.15s, filter 0.15s;
	}

	.cat-chip.dimmed {
		opacity: 0.55;
	}

	.cat-chip.small {
		font-size: 11px;
		padding: 2px 8px;
	}

	.cat-chip:active {
		filter: brightness(1.15);
	}
</style>
