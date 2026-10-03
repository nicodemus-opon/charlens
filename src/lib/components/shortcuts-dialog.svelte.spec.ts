import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ShortcutsDialog from './shortcuts-dialog.svelte';

describe('shortcuts-dialog', () => {
	it('lists every bulk-triage binding when open', async () => {
		render(ShortcutsDialog, { open: true });

		await expect.element(page.getByRole('dialog')).toBeInTheDocument();
		for (const label of [
			'Next story',
			'Previous story',
			'Open selected story',
			'Save / unsave story',
			'Toggle read / unread',
			'Mark all as read',
			'Focus search',
			'Back to list'
		]) {
			await expect.element(page.getByText(label)).toBeInTheDocument();
		}
	});

	it('stays hidden until opened', async () => {
		render(ShortcutsDialog, { open: false });

		expect(await page.getByRole('dialog').all()).toHaveLength(0);
	});
});
