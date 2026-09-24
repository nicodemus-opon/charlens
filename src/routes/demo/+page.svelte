<script lang="ts">
	import { resolve } from '$app/paths';
</script>

<svelte:head>
	<title>Demo · charlens</title>
</svelte:head>

<a href={resolve('/login')}>login (better-auth)</a>
<a href={resolve('/demo/playwright')}>playwright</a>
