import fs from 'node:fs';
import path from 'node:path';

// minimal .env loader so there is no dotenv dependency
function loadEnvFile(file: string): void {
	if (!fs.existsSync(file)) return;
	for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (process.env[key] === undefined) process.env[key] = value;
	}
}

loadEnvFile(path.resolve(process.cwd(), '.env'));

const num = (key: string, fallback: number): number => {
	const v = process.env[key];
	if (v === undefined || v === '') return fallback;
	const parsed = Number(v);
	return Number.isFinite(parsed) ? parsed : fallback;
};

export interface Config {
	serverURL: string;
	password: string;
	syncId: string;
	e2ePassword: string | undefined;
	dataDir: string;
	ollamaUrl: string;
	model: string;
	lookbackDays: number;
	historyDays: number;
	threshold: number;
	ruleThreshold: number;
	historyMinCount: number;
	historyMinShare: number;
	maxNewTags: number;
	newTagThreshold: number;
	tagVocabLimit: number;
	concurrency: number;
}

export const config: Config = {
	serverURL: process.env.ACTUAL_SERVER_URL || '',
	password: process.env.ACTUAL_PASSWORD || '',
	syncId: process.env.ACTUAL_SYNC_ID || '',
	e2ePassword: process.env.ACTUAL_E2E_PASSWORD || undefined,
	dataDir: path.resolve(process.env.ACTUAL_DATA_DIR || './.actual-cache'),

	ollamaUrl: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
	model: process.env.OLLAMA_MODEL || 'qwen2.5:14b',

	lookbackDays: num('AUTOCAT_LOOKBACK_DAYS', 30),
	historyDays: num('AUTOCAT_HISTORY_DAYS', 365),
	threshold: num('AUTOCAT_THRESHOLD', 0.8),
	ruleThreshold: num('AUTOCAT_RULE_THRESHOLD', 0.9),
	historyMinCount: num('AUTOCAT_HISTORY_MIN_COUNT', 3),
	historyMinShare: num('AUTOCAT_HISTORY_MIN_SHARE', 0.8),
	maxNewTags: num('AUTOCAT_MAX_NEW_TAGS', 3),
	newTagThreshold: num('AUTOCAT_NEW_TAG_THRESHOLD', 0.9),
	tagVocabLimit: num('AUTOCAT_TAG_VOCAB_LIMIT', 60),
	concurrency: num('AUTOCAT_CONCURRENCY', 3),
};

export function assertConfig(): void {
	const missing: string[] = [];
	if (!config.serverURL) missing.push('ACTUAL_SERVER_URL');
	if (!config.password) missing.push('ACTUAL_PASSWORD');
	if (!config.syncId) missing.push('ACTUAL_SYNC_ID');
	if (missing.length) {
		throw new Error(
			`Missing required env: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`,
		);
	}
}
