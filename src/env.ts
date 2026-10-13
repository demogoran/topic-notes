import { defineEnvVars } from '@sveltejs/kit/env';

/**
 * Declared environment variables (Kit 3 explicit-env system).
 * Imported serverside via `$app/env/private` — typed, validated at startup.
 */
export const variables = defineEnvVars({
	DATABASE_PATH: {
		description: 'SQLite database file location',
		schema: (value) => value ?? './data/app.db'
	},
	AUDIO_DIR: {
		description: 'Directory for stored audio recordings',
		schema: (value) => value ?? './data/audio'
	},
	SESSION_TTL_DAYS: {
		description: 'Session cookie lifetime in days',
		schema: (value) => (value === undefined ? 30 : Number(value))
	},
	OPENROUTER_API_KEY: {
		description: 'OpenRouter API key (required for transcription/categorization)'
	},
	OPENROUTER_MODEL: {
		description: 'OpenRouter model id used for transcription + categorization',
		schema: (value) => value ?? 'xiaomi/mimo-v2.6-flash'
	},
	OPENROUTER_APP_TITLE: {
		description: 'App title sent to OpenRouter as X-Title',
		schema: (value) => value ?? 'VoiceNotes'
	},
	SONIOX_API_KEY: {
		description: 'Soniox API key (optional — enables the cloud real-time STT engine)'
	}
});
