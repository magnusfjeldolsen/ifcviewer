import { defineConfig } from 'vite';

/** This checkout's own `.claude` folder, as a glob the file watcher understands. */
const agentFolder =
  decodeURIComponent(new URL('./.claude/', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1') + '**';

export default defineConfig({
  // Set base path for GitHub Pages — update 'ifcviewer' to match your repo name
  base: '/ifcviewer/',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    open: true,
    watch: {
      // Agents keep whole checkouts of the repo under .claude/worktrees; a
      // change there must not reload the app served from this checkout.
      // Anchored to this checkout, so a server run from inside a worktree
      // still watches its own files.
      ignored: [agentFolder],
    },
  },
});
