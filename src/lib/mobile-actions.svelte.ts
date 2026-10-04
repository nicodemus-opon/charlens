// Shared UI state for mobile entry points (bottom nav) and the sidebar-owned
// dialogs. The sidebar renders the dialogs; the bottom nav only flips these
// flags open — no prop drilling through the layout needed.
class MobileActionsState {
	/** Opens the command palette (search). */
	paletteOpen = $state(false);
}

export const mobileActions = new MobileActionsState();
