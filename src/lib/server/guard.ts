import { redirect } from '@sveltejs/kit';

/** Auth gate for server loads/actions: everything in the app requires a session. */
export function requireUser(locals: App.Locals) {
	if (!locals.user) redirect(302, '/login');
	return locals.user;
}
