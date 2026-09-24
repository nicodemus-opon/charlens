<script lang="ts">
	import { ChevronsUpDown, LogOut, PanelLeft, Plus, RefreshCw } from '@lucide/svelte';
	import { authClient } from '$lib/auth-client.js';
	import * as Avatar from '$lib/components/ui/avatar/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import ModeToggle from './mode-toggle.svelte';

	type SidebarUser = {
		name: string;
		email: string;
		avatar: string | null;
	};

	let {
		user = null,
		feedsCount = 0,
		onAddContent,
		onRefreshFeeds
	}: {
		user?: SidebarUser | null;
		feedsCount?: number;
		onAddContent?: () => void;
		onRefreshFeeds?: () => void;
	} = $props();

	const sidebar = Sidebar.useSidebar();

	/** The layout redirects to /login without a session, so `user` is almost always set. */
	const name = $derived(user?.name ?? 'charlens');
	const subtitle = $derived(user?.email ?? `${feedsCount} ${feedsCount === 1 ? 'feed' : 'feeds'}`);
	const avatar = $derived(user?.avatar ?? null);
	const initials = $derived(
		name
			.split(/\s+/)
			.map((part) => part[0] ?? '')
			.join('')
			.slice(0, 2)
			.toUpperCase()
	);

	async function signOut() {
		await authClient.signOut();
		// Full navigation so every cached page/layout payload is dropped.
		window.location.href = '/login';
	}
</script>

<Sidebar.Menu>
	<Sidebar.MenuItem>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Sidebar.MenuButton
						{...props}
						size="lg"
						class="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
					>
						<Avatar.Root class="size-8" shape="square">
							{#if avatar}
								<Avatar.Image src={avatar} alt={name} />
							{/if}
							<Avatar.Fallback>{initials}</Avatar.Fallback>
						</Avatar.Root>
						<div class="grid flex-1 text-left text-sm leading-tight">
							<span class="truncate font-medium">{name}</span>
							<span class="truncate text-xs text-muted-foreground">{subtitle}</span>
						</div>
						<ChevronsUpDown class="ml-auto size-4" />
					</Sidebar.MenuButton>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content
				side={sidebar.isMobile ? 'bottom' : 'right'}
				align="end"
				sideOffset={4}
				class="min-w-56"
			>
				<DropdownMenu.Label class="flex items-center gap-2">
					<Avatar.Root class="size-8" shape="square">
						{#if avatar}
							<Avatar.Image src={avatar} alt={name} />
						{/if}
						<Avatar.Fallback>{initials}</Avatar.Fallback>
					</Avatar.Root>
					<div class="grid flex-1 text-left text-sm leading-tight">
						<span class="truncate font-medium">{name}</span>
						<span class="truncate text-xs text-muted-foreground">{subtitle}</span>
					</div>
					<Badge variant="secondary">Self-hosted</Badge>
				</DropdownMenu.Label>
				<DropdownMenu.Separator />
				<DropdownMenu.Group>
					<DropdownMenu.Item onSelect={() => onAddContent?.()}>
						<Plus />
						Add content
					</DropdownMenu.Item>
					<DropdownMenu.Item onSelect={() => onRefreshFeeds?.()}>
						<RefreshCw />
						Refresh feeds
					</DropdownMenu.Item>
				</DropdownMenu.Group>
				<DropdownMenu.Separator />
				<DropdownMenu.Group>
					<ModeToggle />
					<DropdownMenu.Item onSelect={() => sidebar.toggle()}>
						<PanelLeft />
						Toggle sidebar
						<DropdownMenu.Shortcut>⌘B</DropdownMenu.Shortcut>
					</DropdownMenu.Item>
				</DropdownMenu.Group>
				{#if user}
					<DropdownMenu.Separator />
					<DropdownMenu.Item onSelect={() => signOut()}>
						<LogOut />
						Sign out
					</DropdownMenu.Item>
				{/if}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</Sidebar.MenuItem>
</Sidebar.Menu>
