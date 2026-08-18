import api from '@actual-app/api';
import fs from 'node:fs';

import { config } from './config.ts';
import { errorMessage, isoDate, label } from './util.ts';
import type {
	Account,
	CategoryMeta,
	OwnedTransaction,
	Payee,
	Taxonomy,
	TaxonomyGroup,
	Transaction,
} from './types.ts';

export async function connect(): Promise<void> {
	fs.mkdirSync(config.dataDir, { recursive: true });

	await api.init({
		serverURL: config.serverURL,
		password: config.password,
		dataDir: config.dataDir,
	});

	// positional: downloadBudget(syncId, { password }). The published reference
	// shows a single object argument, which stringifies to "[object Object]"
	// as the sync id
	try {
		await api.downloadBudget(
			config.syncId,
			config.e2ePassword ? { password: config.e2ePassword } : {},
		);
	} catch (err) {
		const message = errorMessage(err);
		if (/not found/i.test(message)) {
			throw new Error(`${message}\n${await describeBudgets()}`);
		}
		throw err;
	}
}

async function describeBudgets(): Promise<string> {
	try {
		const budgets = await api.getBudgets();
		if (!budgets?.length) return 'The server reports no budget files for this account.';
		const rows = budgets
			.map(
				b =>
					`  ${b.name}  syncId=${b.cloudFileId ?? b.groupId ?? '(local only)'}${b.hasKey ? '  [encrypted]' : ''}`,
			)
			.join('\n');
		return `Budgets on this server:\n${rows}`;
	} catch (err) {
		return `(could not list budgets: ${errorMessage(err)})`;
	}
}

// runs in a finally block, so it must not mask the error that got us there:
// shutdown throws "No budget file is open" when the download failed
export async function disconnect(): Promise<void> {
	try {
		await api.shutdown();
	} catch (err) {
		const message = errorMessage(err);
		if (!/no budget file is open/i.test(message)) {
			console.warn(`shutdown warning: ${message}`);
		}
	}
}

export { api };

// groups come back with their categories nested, which is the shape the
// two-stage classifier wants. Hidden ones are filtered locally because the
// `hidden` option only exists on newer versions of the package
export async function loadTaxonomy(): Promise<Taxonomy> {
	const groups: TaxonomyGroup[] = (await api.getCategoryGroups())
		.filter(g => !g.hidden)
		.map(g => ({
			id: g.id as string,
			name: g.name,
			is_income: !!g.is_income,
			categories: (g.categories ?? []).filter(c => !c.hidden),
		}))
		.filter(g => g.categories.length > 0);

	const byLabel = new Map<string, string>(),
		byCategoryId = new Map<string, CategoryMeta>();
	for (const g of groups) {
		for (const c of g.categories) {
			byLabel.set(label(g, c), c.id as string);
			byCategoryId.set(c.id as string, { group: g, category: c, label: label(g, c) });
		}
	}
	return { groups, byLabel, byCategoryId };
}

export interface LoadedPayees {
	payees: Payee[];
	byId: Map<string, Payee>;
	transferPayeeIds: Set<string>;
}

export async function loadPayees(): Promise<LoadedPayees> {
	const payees = await api.getPayees(),
		byId = new Map(payees.map(p => [p.id as string, p])),
		transferPayeeIds = new Set(
			payees.filter(p => p.transfer_acct).map(p => p.id as string),
		);
	return { payees, byId, transferPayeeIds };
}

export interface LoadedAccounts {
	accounts: Account[];
	open: Account[];
	byId: Map<string, Account>;
}

export async function loadAccounts(): Promise<LoadedAccounts> {
	const accounts = await api.getAccounts();
	const open = accounts.filter(a => !a.closed);
	return { accounts, open, byId: new Map(accounts.map(a => [a.id as string, a])) };
}

export async function fetchRange(
	accounts: Account[],
	start: Date,
	end: Date,
): Promise<OwnedTransaction[]> {
	const out: OwnedTransaction[] = [];
	for (const acct of accounts) {
		const txns = await api.getTransactions(acct.id as string, isoDate(start), isoDate(end));
		for (const t of txns) out.push({ ...t, _account: acct });
	}
	return out;
}

export interface CandidateSet {
	candidates: OwnedTransaction[];
	skippedSplits: OwnedTransaction[];
}

// candidates have no category, are not transfers and are not split parents.
// split parents come back separately: their children have to be written through
// the parent, which upstream documents as unreliable piecemeal
export function selectCandidates(
	txns: OwnedTransaction[],
	transferPayeeIds: Set<string>,
): CandidateSet {
	const candidates: OwnedTransaction[] = [];
	const skippedSplits: OwnedTransaction[] = [];
	for (const t of txns) {
		if (t.transfer_id) continue;
		if (t.payee && transferPayeeIds.has(t.payee)) continue;
		if (t.is_parent) {
			const uncategorizedChildren = (t.subtransactions ?? []).filter(s => !s.category);
			if (uncategorizedChildren.length) skippedSplits.push(t);
			continue;
		}
		if (t.category) continue;
		candidates.push(t);
	}
	return { candidates, skippedSplits };
}

export interface ApplyOptions {
	note?: string | undefined;
	notes?: string | undefined;
}

// notes end up as: whatever was there, then #tags, then the audit stamp
export async function applyCategory(
	txn: Transaction,
	categoryId: string,
	{ note, notes }: ApplyOptions = {},
): Promise<void> {
	const fields: Record<string, unknown> = { category: categoryId };
	const base = notes ?? txn.notes ?? '';
	if (note) fields.notes = base ? `${base} ${note}` : note;
	else if (notes != null && notes !== (txn.notes ?? '')) fields.notes = notes;
	await api.updateTransaction(txn.id as string, fields);
}
