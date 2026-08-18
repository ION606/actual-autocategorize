import { config } from './config.ts';
import { payeeKey, similarity, tokens } from './util.ts';
import type {
	CategoryMeta,
	History,
	HistoryExample,
	HistoryHit,
	OwnedTransaction,
	Payee,
} from './types.ts';

export interface HistoryKeySet {
	keys: string[];
	full: string;
}

// three lookup keys per transaction, most specific first. The full key alone is
// too specific to carry a run: one merchant shows up as "TRADER JOES #452
// bROOKLYN" and "TRADER JOES #109 QUEENS" and neither collects enough votes
export function historyKeys(
	importedPayee: string | null | undefined,
	payeeName: string | null | undefined,
	payeeId: string | null | undefined,
): HistoryKeySet {
	const keys: string[] = [],
		full = payeeKey(importedPayee, payeeName);
	if (full) keys.push(`full:${full}`);
	if (payeeId) keys.push(`payee:${payeeId}`);
	const name = payeeKey(payeeName);
	if (name) keys.push(`name:${name}`);
	return { keys, full };
}

export function buildHistory(
	txns: OwnedTransaction[],
	payeesById: Map<string, Payee>,
	byCategoryId: Map<string, CategoryMeta>,
): History {
	const votes = new Map<string, Map<string, number>>(),
		examples: HistoryExample[] = [];

	for (const t of txns) {
		if (!t.category || t.transfer_id) continue;
		const meta = byCategoryId.get(t.category);
		if (!meta) continue; // hidden or deleted category

		const payeeId = t.payee ?? null,
			payeeName = (payeeId ? payeesById.get(payeeId)?.name : '') || '',
			{ keys, full } = historyKeys(t.imported_payee, payeeName, payeeId);
		if (!keys.length) continue;

		for (const k of keys) {
			let table = votes.get(k);
			if (!table) {
				table = new Map<string, number>();
				votes.set(k, table);
			}
			table.set(t.category, (table.get(t.category) ?? 0) + 1);
		}

		if (full) {
			examples.push({
				key: full,
				tokens: tokens(full),
				label: meta.label,
				amount: t.amount ?? 0,
				payeeName: payeeName || t.imported_payee || '',
			});
		}
	}

	return { votes, examples };
}

// tier 2: dominant match on the most specific key with enough votes. Null when
// every key is too thin or too split to trust
export function historyGuess(history: History, keys: string[]): HistoryHit | null {
	for (const key of keys) {
		const table = history.votes.get(key);
		if (!table) continue;

		let total = 0,
			best: string | null = null,
			bestCount = 0;
		for (const [categoryId, count] of table) {
			total += count;
			if (count > bestCount) {
				best = categoryId;
				bestCount = count;
			}
		}
		if (best === null || total < config.historyMinCount) continue;

		const share = bestCount / total;
		if (share < config.historyMinShare) continue;

		return {
			categoryId: best,
			confidence: Math.min(0.99, share),
			count: bestCount,
			total,
			key,
		};
	}
	return null;
}

// few-shot material: the most similar past transactions, deduped by the category
// they landed in so the model sees a spread of plausible answers
export function nearestExamples(
	history: History,
	key: string,
	limit = 8,
): HistoryExample[] {
	const target = tokens(key);
	const scored: (HistoryExample & { score: number })[] = [];
	const seen = new Set<string>();

	for (const ex of history.examples) {
		const dedupeKey = `${ex.key}|${ex.label}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		const score = ex.key === key ? 1 : similarity(target, ex.tokens);
		if (score > 0) scored.push({ ...ex, score });
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit);
}
