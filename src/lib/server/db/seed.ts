// Standalone seed runner (no $lib/$env imports so it works under tsx/vite-node).
//
// Feeds are private per user, so there is no global library to seed.
// New accounts start empty and add their own feeds from the UI.
// This script is kept as a no-op so `pnpm db:seed` doesn't break old docs.

async function main() {
	console.log('seed: feeds are per-user, nothing to seed globally. New accounts start empty.');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
