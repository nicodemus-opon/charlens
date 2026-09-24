import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { env } from '$env/dynamic/private';
import { auth } from '$lib/server/auth';
import { APIError } from 'better-auth/api';

export const load: PageServerLoad = (event) => {
	if (event.locals.user) redirect(302, '/');
	return { signupDisabled: env.AUTH_DISABLE_SIGNUP === '1' };
};

export const actions: Actions = {
	signInEmail: async (event) => {
		const formData = await event.request.formData();
		const email = formData.get('email')?.toString() ?? '';
		const password = formData.get('password')?.toString() ?? '';

		try {
			await auth.api.signInEmail({ body: { email, password } });
		} catch (error) {
			if (error instanceof APIError) {
				return fail(400, { mode: 'signin', message: error.message || 'Sign in failed' });
			}
			return fail(500, { mode: 'signin', message: 'Unexpected error' });
		}

		redirect(302, '/');
	},
	signUpEmail: async (event) => {
		if (env.AUTH_DISABLE_SIGNUP === '1') {
			return fail(403, { mode: 'signup', message: 'Registration is disabled on this instance.' });
		}
		const formData = await event.request.formData();
		const email = formData.get('email')?.toString() ?? '';
		const password = formData.get('password')?.toString() ?? '';
		const name = formData.get('name')?.toString() ?? '';

		if (!name.trim()) return fail(400, { mode: 'signup', message: 'Name is required' });

		try {
			await auth.api.signUpEmail({ body: { email, password, name } });
		} catch (error) {
			if (error instanceof APIError) {
				return fail(400, { mode: 'signup', message: error.message || 'Registration failed' });
			}
			return fail(500, { mode: 'signup', message: 'Unexpected error' });
		}

		redirect(302, '/');
	}
};
