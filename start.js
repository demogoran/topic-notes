// Starts the adapter-node build (build/index.js auto-listens on PORT).
// Kept as a tiny wrapper so `pnpm start` has one obvious entry point.
await import('./build/index.js');
