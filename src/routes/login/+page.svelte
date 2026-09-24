<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import type { ActionData, PageServerData } from './$types';

	let { data, form }: { data: PageServerData; form: ActionData } = $props();

	let mode = $state<'signin' | 'signup'>('signin');
	let busy = $state(false);

	// Bounce back into sign-up mode when the server rejects a registration.
	$effect(() => {
		if (form?.mode === 'signup') mode = 'signup';
	});

	const isSignup = $derived(mode === 'signup');
</script>

<svelte:head>
	<title>{isSignup ? 'Sign up' : 'Sign in'} · charlens</title>
</svelte:head>

<div class="flex min-h-dvh items-center justify-center bg-muted p-4 sm:p-6">
	<Card.Root class="w-full max-w-sm">
		<Card.Header class="items-center text-center">
			<img src="/logo.png" alt="charlens logo" class="size-10 rounded-full" />
			<Card.Title class="text-xl">charlens</Card.Title>
			<Card.Description>
				{isSignup ? 'Create your account' : 'Sign in to your account'}
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<form
				method="post"
				action={isSignup ? '?/signUpEmail' : '?/signInEmail'}
				use:enhance={() => {
					busy = true;
					return async ({ update }) => {
						busy = false;
						await update();
					};
				}}
				class="flex flex-col gap-4"
			>
				{#if isSignup}
					<div class="flex flex-col gap-2">
						<Label for="name">Name</Label>
						<Input id="name" name="name" autocomplete="name" required />
					</div>
				{/if}
				<div class="flex flex-col gap-2">
					<Label for="email">Email</Label>
					<Input id="email" name="email" type="email" autocomplete="email" required />
				</div>
				<div class="flex flex-col gap-2">
					<Label for="password">Password</Label>
					<Input
						id="password"
						name="password"
						type="password"
						autocomplete={isSignup ? 'new-password' : 'current-password'}
						minlength={8}
						required
					/>
				</div>
				{#if form?.message}
					<p class="text-sm text-destructive">{form.message}</p>
				{/if}
				<Button type="submit" disabled={busy} class="w-full">
					{busy ? 'Please wait…' : isSignup ? 'Create account' : 'Sign in'}
				</Button>
			</form>
		</Card.Content>
		<Card.Footer class="flex-col gap-2">
			{#if !data.signupDisabled}
				<Button variant="link" onclick={() => (mode = isSignup ? 'signin' : 'signup')}>
					{isSignup ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
				</Button>
			{/if}
		</Card.Footer>
	</Card.Root>
</div>
