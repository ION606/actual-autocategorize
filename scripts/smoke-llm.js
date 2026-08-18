// offline smoke test: exercises the two-stage classifier and the history tiers
// against a synthetic taxonomy. No Actual server needed.
import { classify, checkModel } from '../src/llm.js';
import { buildHistory, historyGuess, historyKeys, nearestExamples } from '../src/history.js';

const groups = [
	{
		id: 'g1',
		name: 'Food',
		is_income: false,
		categories: [
			{ id: 'c1', name: 'Groceries' },
			{ id: 'c2', name: 'Restaurants' },
			{ id: 'c3', name: 'Coffee' },
		],
	},
	{
		id: 'g2',
		name: 'Bills',
		is_income: false,
		categories: [
			{ id: 'c4', name: 'Electric' },
			{ id: 'c5', name: 'Internet' },
			{ id: 'c6', name: 'Phone' },
		],
	},
	{
		id: 'g3',
		name: 'Transport',
		is_income: false,
		categories: [
			{ id: 'c7', name: 'Gas' },
			{ id: 'c8', name: 'Transit' },
			{ id: 'c9', name: 'Rideshare' },
		],
	},
	{
		id: 'g4',
		name: 'Income',
		is_income: true,
		categories: [{ id: 'c10', name: 'Salary' }],
	},
];

const byLabel = new Map();
const byCategoryId = new Map();
for (const g of groups) {
	for (const c of g.categories) {
		byLabel.set(`${g.name}: ${c.name}`, c.id);
		byCategoryId.set(c.id, { group: g, category: c, label: `${g.name}: ${c.name}` });
	}
}
const taxonomy = { groups, byLabel, byCategoryId };

const cases = [
	{ imported_payee: 'TRADER JOES #452 BROOKLYN NY', amount: -6231, expect: 'Food: Groceries' },
	{ imported_payee: 'CON EDISON BILLPAY 8827361', amount: -14002, expect: 'Bills: Electric' },
	{ imported_payee: 'UBER *TRIP 4RT2X', amount: -1875, expect: 'Transport: Rideshare' },
	{ imported_payee: 'SHELL OIL 574839201', amount: -4510, expect: 'Transport: Gas' },
	{ imported_payee: 'ACME CORP DIRECT DEP PAYROLL', amount: 320000, expect: 'Income: Salary' },
	{ imported_payee: 'BLUE BOTTLE COFFEE 12', amount: -725, expect: 'Food: Coffee' },
];

// fake history so the few-shot path is exercised too.
const payeesById = new Map([['p1', { id: 'p1', name: 'Trader Joes' }]]);
const historyTxns = [
	{ category: 'c1', imported_payee: 'TRADER JOES #452 BROOKLYN NY', payee_id: 'p1', amount: -5510 },
	{ category: 'c1', imported_payee: 'TRADER JOES #109 QUEENS NY', payee_id: 'p1', amount: -3320 },
	{ category: 'c1', imported_payee: 'TRADER JOES #452 BROOKLYN NY', payee_id: 'p1', amount: -7710 },
	{ category: 'c4', imported_payee: 'CON EDISON BILLPAY 111', payee_id: null, amount: -13000 },
];
const history = buildHistory(historyTxns, payeesById, byCategoryId);

await checkModel();

// tier 2 check.
const { keys: tjKeys } = historyKeys('TRADER JOES #452 BROOKLYN NY', 'Trader Joes', 'p1');
const hit = historyGuess(history, tjKeys);
console.log(
	`history tier: ${hit ? `${byCategoryId.get(hit.categoryId).label} (${hit.count}/${hit.total})` : 'no hit'}`,
);

// tier 3 check.
let correct = 0;
for (const c of cases) {
	const txn = {
		date: '2026-08-14',
		amount: c.amount,
		imported_payee: c.imported_payee,
		notes: null,
		_account: { name: 'Checking' },
	};
	const { full: key } = historyKeys(c.imported_payee, '', null);
	const started = Date.now();
	const out = await classify(txn, '', taxonomy, nearestExamples(history, key));
	const secs = ((Date.now() - started) / 1000).toFixed(1);
	const ok = out.label === c.expect;
	if (ok) correct++;
	console.log(
		`${ok ? 'ok  ' : 'MISS'} ${c.imported_payee.padEnd(32)} -> ${(out.label ?? out.abstained ?? out.error ?? '?').padEnd(22)
		} conf ${(out.confidence ?? 0).toFixed(2)}  want ${c.expect}  ${secs}s`,
	);
}
console.log(`\n${correct}/${cases.length} correct`);
