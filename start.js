// Starts the adapter-node build. Loads .env for non-container deployments
// (Node 22+ builtin `process.loadEnvFile`); real env vars always win.
import process from 'node:process';

try {
	process.loadEnvFile();
} catch {
	// no .env file — fine in container/PaaS deployments
}

await import('./build/index.js');
