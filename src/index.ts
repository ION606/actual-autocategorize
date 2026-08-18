#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { config, assertConfig } from './config.ts';
import {
	api,
	applyCategory,
	connect,
	disconnect,
	fetchRange,
	loadAccounts,
	loadPayees,
	loadTaxonomy,
	selectCandidates,
} from './actual.ts';
import { buildHistory, historyGuess, historyKeys, nearestExamples } from './history.ts';
import { checkModel, classify, suggestTags } from './llm.ts';
import { learnRule } from './rules.ts';
import { applyTagsToNotes, loadTagVocabulary, registerTag, vetTags } from './tags.ts';
import { daysAgo, errorMessage, mapOrderedConcurrent, signedDollars } from './util.ts';
import type {
	Decision,
	OwnedTransaction,
	TagSuggestion,
	TagVocabulary,
	VettedTags,
} from './types.ts';

interface Args {
	apply: boolean;
	learn: boolean;
	bankSync: boolean;
	backup: boolean;
	days: number;
	historyDays: number;
	threshold: number;
	limit: number;
	account: string | null;
	tags: boolean;
	newTags: boolean;
	maxNewTags: number;
	newTagThreshold: number;
	concurrency: number;
	help: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		apply: false,
		learn: false,
		bankSync: false,
		backup: false,
		days: config.lookbackDays,
		historyDays: config.historyDays,
		threshold: config.threshold,
		limit: Infinity,
		account: null,
		tags: false,
		newTags: false,
		maxNewTags: config.maxNewTags,
		newTagThreshold: config.newTagThreshold,
		concurrency: config.concurrency,
		help: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i],
			next = (): string => argv[++i] ?? '';

		switch (a) {
			case '--apply': args.apply = true; break;
			case '--dry-run': args.apply = false; break;
			case '--learn': args.learn = true; break;
			case '--bank-sync': args.bankSync = true; break;
			case '--backup': args.backup = true; break;
			case '--days': args.days = Number(next()); break;
			case '--history-days': args.historyDays = Number(next()); break;
			case '--threshold': args.threshold = Number(next()); break;
			case '--tags': args.tags = true; break;
			case '--new-tags': args.tags = true; args.newTags = true; break;
			case '--max-new-tags': args.maxNewTags = Number(next()); break;
			case '--new-tag-threshold': args.newTagThreshold = Number(next()); break;
			case '--concurrency': args.concurrency = Number(next()); break;
			case '--limit': args.limit = Number(next()); break;
			case '--account': args.account = next(); break;
			case '-h': case '--help': args.help = true; break;
			default:
				throw new Error(`Unknown argument: ${a}`);
		}
	}

	return args;
}

// dISCLAIMER: The HELP block was generated via LLM
const HELP = `
actual-autocat - auto-categorize Actual Budget transactions with a local LLM

Usage: npm start -- [options]

  --apply           Write categories back. Default is a dry run.
  --learn           Also create an Actual rule for high-confidence payees.
  --bank-sync       Run the bank sync (GoCardless/SimpleFIN) before reading.
  --backup          Export the budget to ./out before making any change.
  --days N          Lookback window for uncategorized transactions (default ${config.lookbackDays}).
  --history-days N  Window used to learn payee->category history (default ${config.historyDays}).
  --threshold X     Minimum confidence to apply (default ${config.threshold}).
  --limit N         Stop after N candidates. Useful for a first calibration run.
  --account NAME    Restrict to one account by name.
  --concurrency N   Transactions classified at once (default ${config.concurrency}).

  --tags            Also suggest tags, but only ones that already exist.
  --new-tags        Implies --tags, and lets it coin new tags too.
  --max-new-tags N  Cap on new tags coined per run (default ${config.maxNewTags}).
  --new-tag-threshold X
                    Confidence needed to coin a new tag (default ${config.newTagThreshold}).

  -h, --help        Show this help.
`;

// rows written to ./out
interface AppliedRecord {
	id: string;
	date: string;
	amount: number;
	payee: string;
	imported_payee: string | null;
	category: string | undefined;
	categoryId: string;
	confidence: number;
	source: string;
	reason: string | null;
	tags: string[];
	newTag: string | null;
}

interface ReviewRecord {
	id: string;
	date: string;
	account: string | undefined;
	amount: number;
	payee: string;
	imported_payee: string | null;
	suggestion: string | null;
	confidence: number;
	abstained: string | null;
	error: string | null;
}

interface CoinedRecord {
	tag: string;
	from: string;
	category: string | undefined;
}

// what the concurrent stage produces for one transaction. Nothing here touches
// shared state; the sequential stage below owns all of it
interface Classified {
	payeeId: string | null;
	payeeName: string;
	decision: Decision;
	suggestion: TagSuggestion | null;
	suggestionError: string | null;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(HELP);
		return;
	}

	assertConfig();
	await checkModel();

	const outDir = path.resolve('./out');
	fs.mkdirSync(outDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');

	console.log(
		`mode: ${args.apply ? 'APPLY' : 'dry run'}  model: ${config.model}  concurrency: ${args.concurrency}`,
	);
	await connect();

	try {
		const { open, byId: accountsById } = await loadAccounts();
		let accounts = open;
		if (args.account) {
			accounts = open.filter(a => a.name === args.account);
			if (!accounts.length) {
				throw new Error(
					`No open account named "${args.account}". Open accounts: ${open.map(a => a.name).join(', ')}`,
				);
			}
		}

		if (args.bankSync) {
			for (const acct of accounts) {
				try {
					await api.runBankSync({ accountId: acct.id as string });
					console.log(`bank sync ok: ${acct.name}`);
				} catch (err) {
					console.warn(`bank sync failed for ${acct.name}: ${errorMessage(err)}`);
				}
			}
		}

		if (args.backup && args.apply) {
			const bytes = await api.exportBudget();
			const file = path.join(outDir, `budget-backup-${stamp}.zip`);
			fs.writeFileSync(file, Buffer.from(bytes));
			console.log(`backup written: ${file}`);
		}

		const taxonomy = await loadTaxonomy(),
			{ byId: payeesById, transferPayeeIds } = await loadPayees();
		console.log(
			`taxonomy: ${taxonomy.groups.length} groups, ${taxonomy.byLabel.size} categories`,
		);

		const now = new Date(),
			historyTxns = await fetchRange(accounts, daysAgo(args.historyDays), now),
			history = buildHistory(historyTxns, payeesById, taxonomy.byCategoryId);

		console.log(
			`history: ${history.examples.length} categorized transactions, ${history.votes.size} payee keys`,
		);

		const recent = await fetchRange(accounts, daysAgo(args.days), now),
			{ candidates: allCandidates, skippedSplits } = selectCandidates(recent, transferPayeeIds);

		console.log(
			`candidates: ${allCandidates.length} uncategorized in the last ${args.days} days` +
			(skippedSplits.length ? ` (${skippedSplits.length} split parents skipped)` : ''),
		);

		let vocabulary: TagVocabulary = { tags: [], set: new Set(), registered: new Set() };
		if (args.tags) {
			vocabulary = await loadTagVocabulary(historyTxns);
			console.log(
				`tags: ${vocabulary.set.size} in vocabulary` +
				(args.newTags ? `, up to ${args.maxNewTags} new ones allowed this run` : ', no new tags'),
			);
		}

		const applied: AppliedRecord[] = [],
			review: ReviewRecord[] = [],
			coined: CoinedRecord[] = [];

		let newTagBudget = args.newTags ? args.maxNewTags : 0;

		const candidates = Number.isFinite(args.limit)
			? allCandidates.slice(0, args.limit)
			: allCandidates;

		// classifying one transaction is independent of every other, so these
		// overlap. The new-tag budget is deliberately not enforced here: a worker
		// only asks the model for a new tag if the budget had room when it
		// started, and the sequential stage below applies the real remaining
		// budget
		const classifyOne = async (txn: OwnedTransaction): Promise<Classified> => {
			const payeeId = txn.payee ?? null,
				payeeName = (payeeId ? payeesById.get(payeeId)?.name : '') || '',
				{ keys, full: key } = historyKeys(txn.imported_payee, payeeName, payeeId);

			let decision: Decision;

			// tier 2: dominant payee history
			const hist = keys.length ? historyGuess(history, keys) : null;
			if (hist) {
				decision = {
					source: 'history',
					categoryId: hist.categoryId,
					label: taxonomy.byCategoryId.get(hist.categoryId)?.label,
					confidence: hist.confidence,
					reason: `${hist.count}/${hist.total} past transactions matched on ${hist.key}`,
				};
			} else {
				// tier 3: two-stage local LLM
				const examples = nearestExamples(history, key);
				try {
					decision = await classify(txn, payeeName, taxonomy, examples);
				} catch (err) {
					decision = { source: 'llm', error: errorMessage(err), confidence: 0 };
				}
			}

			// stage 3 only runs for a transaction that will actually be written
			let suggestion: TagSuggestion | null = null;
			let suggestionError: string | null = null;
			if (args.tags && decision.categoryId && decision.confidence >= args.threshold) {
				try {
					suggestion = await suggestTags(
						txn,
						payeeName,
						decision.label,
						vocabulary.tags.slice(0, config.tagVocabLimit),
						newTagBudget > 0,
					);
				} catch (err) {
					suggestionError = errorMessage(err);
				}
			}

			return { payeeId, payeeName, decision, suggestion, suggestionError };
		};

		// consumed in the original order, so output, the new-tag budget and every
		// write stay deterministic
		for await (const { item: txn, result } of mapOrderedConcurrent(
			candidates,
			args.concurrency,
			classifyOne,
		)) {
			if (!result.ok) {
				console.warn(`ERROR ${txn.date} ${txn.imported_payee ?? ''}: ${errorMessage(result.error)}`);
				continue;
			}

			const { payeeId, payeeName, decision, suggestion, suggestionError } = result.value;

			const desc = `${txn.date}  ${signedDollars(txn.amount).padStart(11)}  ${(payeeName || txn.imported_payee || '(no payee)').slice(0, 32).padEnd(32)
				}`;

			if (!decision.categoryId || decision.confidence < args.threshold) {
				review.push({
					id: txn.id as string,
					date: txn.date,
					account: accountsById.get(txn.account as string)?.name,
					amount: txn.amount ?? 0,
					payee: payeeName,
					imported_payee: txn.imported_payee ?? null,
					suggestion: decision.label ?? null,
					confidence: decision.confidence,
					abstained: decision.abstained ?? null,
					error: decision.error ?? null,
				});
				console.log(
					`SKIP  ${desc} -> ${decision.label ?? decision.abstained ?? decision.error ?? 'no answer'} (${decision.confidence.toFixed(2)})`,
				);
				continue;
			}

			let tagResult: VettedTags = { tags: [], newTag: null, rejected: [] };
			if (suggestionError) {
				tagResult.rejected.push({ tag: null, why: `llm error: ${suggestionError}` });
			} else if (suggestion) {
				tagResult = vetTags(suggestion, vocabulary, {
					threshold: args.threshold,
					newTagThreshold: args.newTagThreshold,
					allowNew: newTagBudget > 0,
					newTagBudget,
					categoryLabel: decision.label,
					payeeName: payeeName || txn.imported_payee || '',
				});
			}

			const tagSuffix = tagResult.tags.length
				? `  ${tagResult.tags.map(t => `#${t}`).join(' ')}${tagResult.newTag ? ' (new)' : ''}`
				: '';

			console.log(
				`${args.apply ? 'SET ' : 'WOULD'}  ${desc} -> ${decision.label} (${decision.confidence.toFixed(2)}, ${decision.source})${tagSuffix}`,
			);
			for (const r of tagResult.rejected) {
				console.log(`      tag rejected${r.tag ? ` "${r.tag}"` : ''}: ${r.why}`);
			}

			if (tagResult.newTag) {
				newTagBudget--;
				vocabulary.set.add(tagResult.newTag);
				vocabulary.tags.push({ tag: tagResult.newTag, count: 0 });
				coined.push({
					tag: tagResult.newTag,
					from: payeeName || txn.imported_payee || '',
					category: decision.label,
				});
			}

			if (args.apply) {
				const note = `[autocat ${decision.source === 'llm' ? config.model : 'history'} ${decision.confidence.toFixed(2)}]`;

				const notes = tagResult.tags.length
					? applyTagsToNotes(txn.notes, tagResult.tags)
					: undefined;

				await applyCategory(txn, decision.categoryId, { note, notes });

				if (tagResult.newTag) {
					const registered = await registerTag(tagResult.newTag);
					console.log(
						`      coined #${tagResult.newTag}${registered ? ' (registered)' : ' (in notes only)'}`,
					);
				}

				if (args.learn && payeeId && decision.confidence >= config.ruleThreshold) {
					const res = await learnRule(payeeId, decision.categoryId);
					if (res.created) console.log(`      rule created for payee "${payeeName}"`);
				}
			}

			applied.push({
				id: txn.id as string,
				date: txn.date,
				amount: txn.amount ?? 0,
				payee: payeeName,
				imported_payee: txn.imported_payee ?? null,
				category: decision.label,
				categoryId: decision.categoryId,
				confidence: decision.confidence,
				source: decision.source,
				reason: decision.reason ?? null,
				tags: tagResult.tags,
				newTag: tagResult.newTag,
			});
		}

		if (args.apply && applied.length) {
			await api.sync();
		}

		const reviewFile = path.join(outDir, `review-${stamp}.jsonl`),
			appliedFile = path.join(outDir, `${args.apply ? 'applied' : 'proposed'}-${stamp}.jsonl`);

		fs.writeFileSync(reviewFile, review.map(r => JSON.stringify(r)).join('\n'));
		fs.writeFileSync(appliedFile, applied.map(r => JSON.stringify(r)).join('\n'));

		const bySource = applied.reduce<Record<string, number>>((acc, a) => {
			acc[a.source] = (acc[a.source] ?? 0) + 1;
			return acc;
		}, {});

		console.log(
			`\n${args.apply ? 'applied' : 'proposed'}: ${applied.length} ` +
			`(${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})  ` +
			`needs review: ${review.length}`,
		);
		console.log(`  ${appliedFile}`);
		console.log(`  ${reviewFile}`);

		if (args.tags) {
			const tagged = applied.filter(a => a.tags.length).length;
			console.log(`tagged: ${tagged}`);

			if (coined.length) {
				console.log(
					`${args.apply ? 'coined' : 'would coin'} ${coined.length} new tag(s):\n` +
					coined.map(c => `  #${c.tag}  (from "${c.from}", ${c.category})`).join('\n'),
				);
			} else if (args.newTags) {
				console.log('no new tags coined');
			}
		}

		if (!args.apply && applied.length) {
			console.log('\nNothing was written. Re-run with --apply (add --backup on the first real run).');
		}

		if (skippedSplits.length) {
			console.log(
				`\n${skippedSplits.length} split transactions have uncategorized children; ` +
				'they are left alone because subtransactions must be rewritten through the parent.',
			);
		}
	} finally {
		await disconnect();
	}
}

main().catch((err: unknown) => {
	console.error(`\nerror: ${errorMessage(err)}`);
	process.exitCode = 1;
});
