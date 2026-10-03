// Shared open-state for the keyboard-shortcuts dialog. The `?` key (reader
// page) and the avatar menu (sidebar, every page) target the single
// layout-level dialog instance below.

class ShortcutsState {
	open = $state(false);
}

export const shortcutsState = new ShortcutsState();
