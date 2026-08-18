// runs the classifier and the history tier against a synthetic taxonomy.
// needs ollama, not an Actual server
import { classify, checkModel } from '../src/llm.ts';
import { buildHistory, historyGuess, historyKeys, nearestExamples } from '../src/history.ts';
import type {
	Category,
	CategoryMeta,
	OwnedTransaction,
	Payee,
	Taxonomy,
	TaxonomyGroup,
} from '../src/types.ts';

const cat = (id: string, name: string): Category => ({ id, name }) as Category;

const groups: TaxonomyGroup[] = [
	{
		id: 'g1',
		name: 'Food',
		is_income: false,
		categories: [cat('c1', 'Groceries'), cat('c2', 'Restaurants'), cat('c3', 'Coffee')],
	},
	{
		id: 'g2',
		name: 'Bills',
		is_income: false,
		categories: [cat('c4', 'Electric'), cat('c5', 'Internet'), cat('c6', 'Phone')],
	},
	{
		id: 'g3',
		name: 'Transport',
		is_income: false,
		categories: [cat('c7', 'Gas'), cat('c8', 'Transit'), cat('c9', 'Rideshare')],
	},
	{
		id: 'g4',
		name: 'Income',
		is_income: true,
		categories: [cat('c10', 'Salary')],
	},
];

const byLabel = new Map<string, string>();
const byCategoryId = new Map<string, CategoryMeta>();
for (const g of groups) {
	for (const c of g.categories) {
		const label = `${g.name}: ${c.name}`;
		byLabel.set(label, c.id as string);
		byCategoryId.set(c.id as string, { group: g, category: c, label });
	}
}
const taxonomy: Taxonomy = { groups, byLabel, byCategoryId };

interface Case {
	imported_payee: string;
	amount: number;
	expect: string;
}

const cases: Case[] = [
	{ imported_payee: 'TRADER JOES #452 BROOKLYN NY', amount: -6231, expect: 'Food: Groceries' },
	{ imported_payee: 'CON EDISON BILLPAY 8827361', amount: -14002, expect: 'Bills: Electric' },
	{ imported_payee: 'UBER *TRIP 4RT2X', amount: -1875, expect: 'Transport: Rideshare' },
	{ imported_payee: 'SHELL OIL 574839201', amount: -4510, expect: 'Transport: Gas' },
	{ imported_payee: 'ACME CORP DIRECT DEP PAYROLL', amount: 320000, expect: 'Income: Salary' },
	{ imported_payee: 'BLUE BOTTLE COFFEE 12', amount: -725, expect: 'Food: Coffee' },
];

// fake history so the few-shot path runs too
const payeesById = new Map<string, Payee>([['p1', { id: 'p1', name: 'Trader Joes' } as Payee]]);
const historyTxns = [
	{ category: 'c1', imported_payee: 'TRADER JOES #452 BROOKLYN NY', payee: 'p1', amount: -5510 },
	{ category: 'c1', imported_payee: 'TRADER JOES #109 QUEENS NY', payee: 'p1', amount: -3320 },
	{ category: 'c1', imported_payee: 'TRADER JOES #452 BROOKLYN NY', payee: 'p1', amount: -7710 },
	{ category: 'c4', imported_payee: 'CON EDISON BILLPAY 111', payee: null, amount: -13000 },
] as unknown as OwnedTransaction[];
const history = buildHistory(historyTxns, payeesById, byCategoryId);

await checkModel();

// tier 2
const { keys: tjKeys } = historyKeys('TRADER JOES #452 BROOKLYN NY', 'Trader Joes', 'p1');
const hit = historyGuess(history, tjKeys);
console.log(
	`history tier: ${hit ? `${byCategoryId.get(hit.categoryId)?.label} (${hit.count}/${hit.total})` : 'no hit'}`,
);

// tier 3
let correct = 0;
for (const c of cases) {
	const txn = {
		date: '2026-08-14',
		amount: c.amount,
		imported_payee: c.imported_payee,
		notes: null,
		_account: { name: 'Checking' },
	} as unknown as OwnedTransaction;
	const { full: key } = historyKeys(c.imported_payee, '', null);
	const started = Date.now();
	const out = await classify(txn, '', taxonomy, nearestExamples(history, key));
	const secs = ((Date.now() - started) / 1000).toFixed(1);
	const ok = out.label === c.expect;
	if (ok) correct++;
	console.log(
		`${ok ? 'ok  ' : 'MISS'} ${c.imported_payee.padEnd(32)} -> ${(out.label ?? out.abstained ?? out.error ?? '?').padEnd(22)
		} conf ${out.confidence.toFixed(2)}  want ${c.expect}  ${secs}s`,
	);
}
console.log(`\n${correct}/${cases.length} correct`);
