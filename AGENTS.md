## Project Configuration

- **Language**: TypeScript
- **Package Manager**: pnpm
- **Add-ons**: prettier, vitest, playwright, tailwindcss, sveltekit-adapter, drizzle, better-auth, ai-tools, shadcn-svelte, oxlint + @shadcn/lint

---

## UI / Design System (STRICT — always follow)

- **Always use shadcn-svelte components, never raw HTML for UI.** Import from `$lib/components/ui/*` (e.g. `import { Button } from "$lib/components/ui/button/index.js"`). If a needed component is missing, add it with `pnpm dlx shadcn-svelte@latest add <component>` instead of hand-rolling markup. Raw `<button>`, `<input>`, `<select>`, `<dialog>`, cards, etc. are forbidden when a shadcn equivalent exists.
- **Always use theme colors, never custom/raw ones.** Only use semantic tokens defined in `src/routes/layout.css` (`bg-background`, `text-foreground`, `bg-primary`, `text-primary-foreground`, `bg-secondary`, `bg-muted`, `text-muted-foreground`, `bg-accent`, `bg-destructive`, `border-border`, `bg-card`, etc.). Never use raw palette classes (`bg-pink-500`, `text-red-400`, …), arbitrary color values (`bg-[#333]`, `p-[13px]`), or inline `style=` / `<style>` for colors/spacing. To add a new color, declare a `--color-*` token in `src/routes/layout.css` (see Theming in `docs/shadcn-svelte-llms.txt`) and then use it.
- **Component styling policy:** pass only `layout` classes (`mt-4`, `w-full`, `hidden`, `flex-1`, …) via `class` on shadcn components. Appearance (color, typography, spacing, shape) belongs to the component's variants (`variant=`, `size=`). Do not restyle with `class="p-4 bg-pink-500 rounded-full"`.
- **Local docs:** full shadcn-svelte doc index is vendored at `docs/shadcn-svelte-llms.txt` (source: https://www.shadcn-svelte.com/llms.txt). Fetch linked `*.md` pages from the site when you need API details.
- **Lint is the enforcer:** design rules live in `.oxlintrc.json` (`@shadcn/lint`: `no-restyle`, `no-raw-colors`, `no-arbitrary-values`, `no-inline-styles`, `no-unknown-classes`, `require-static-classes`). Component internals in `src/lib/components/ui/**` are exempt from restyle/arbitrary/static checks.

After making changes, run `pnpm run lint` and fix all errors.

---

## Browser Automation / Playwright (STRICT — always follow)

- **Always use the globally installed Playwright CLI** (`playwright-cli`, installed via `npm install -g @playwright/cli`) for any Playwright/browser automation task. Never use `npx playwright`, `npx @playwright/cli`, or ad-hoc Playwright scripts — the npx cache is wiped between sessions and re-downloads everything each time.
- Browsers are already installed in the persistent cache (`~/Library/Caches/ms-playwright`). If a browser is missing, run `playwright-cli install-browser chromium` once — never reinstall per session.
- System Chrome is not installed on this machine: always pass `--browser chromium` to `playwright-cli open` (default `chrome` channel fails).
- **CLI docs:** https://playwright.dev/agent-cli/introduction (command reference: https://playwright.dev/agent-cli/command-reference).

---

You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

## Available Svelte MCP Tools:

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get-documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list-sections tool, you MUST analyze the returned documentation sections (especially the use_cases field) and then use the get-documentation tool to fetch ALL documentation sections that are relevant for the user's task.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions.
You MUST use this tool whenever writing Svelte code before sending it to the user. Keep calling it until no issues or suggestions are returned.

### 4. playground-link

Generates a Svelte Playground link with the provided code.
After completing the code, ask the user if they want a playground link. Only call this tool after user confirmation and NEVER if code was written to files in their project.
