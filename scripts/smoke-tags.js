// offline test of the tag layer: guardrails are pure functions, the stage-3
// prompt runs against ollama. No Actual server needed.
import assert from 'node:assert/strict';

import { checkModel, suggestTags } from '../src/llm.js';
import {
	applyTagsToNotes,
	extractTags,
	findNearDuplicate,
	normalizeTag,
	vetTags,
} from '../src/tags.js';

// --- pure guardrails ------------------------------------------------------

assert.equal(normalizeTag('#Work Travel'), 'work-travel');
assert.equal(normalizeTag('  reimbursable '), 'reimbursable');
assert.equal(normalizeTag('a'), null, 'single char rejected');
assert.equal(normalizeTag('x'.repeat(40)), null, 'overlong rejected');
assert.equal(normalizeTag('!!!'), null, 'punctuation-only rejected');

const existing = new Set(['groceries', 'work-travel', 'reimbursable']);
assert.equal(findNearDuplicate('grocery', existing), 'groceries', 'singular snaps to plural');
assert.equal(findNearDuplicate('grocerie', existing), 'groceries', 'edit distance 1 snaps');
assert.equal(findNearDuplicate('vacation', existing), null, 'genuinely new stays new');

assert.deepEqual(extractTags('lunch #work-travel #reimbursable'), ['work-travel', 'reimbursable']);
assert.equal(applyTagsToNotes('lunch #work-travel', ['work-travel', 'vacation']), 'lunch #work-travel #vacation');
assert.equal(applyTagsToNotes('', ['vacation']), '#vacation');

const vocabulary = { set: existing, tags: [...existing].map(tag => ({ tag, count: 5 })) };
const baseOpts = {
	threshold: 0.8,
	newTagThreshold: 0.9,
	allowNew: true,
	newTagBudget: 3,
	categoryLabel: 'Food: Groceries',
	payeeName: 'Trader Joes',
};

let r = vetTags({ tags: ['groceries'], confidence: 0.95, newTag: '', newTagConfidence: 0 }, vocabulary, baseOpts);
assert.deepEqual(r.tags, ['groceries']);
assert.equal(r.newTag, null);

r = vetTags({ tags: [], confidence: 0.9, newTag: 'grocery', newTagConfidence: 0.95 }, vocabulary, baseOpts);
assert.equal(r.newTag, null, 'near-duplicate must not be coined');
assert.deepEqual(r.tags, ['groceries'], 'snaps to the existing tag instead');

r = vetTags({ tags: [], confidence: 0.9, newTag: 'groceries-food', newTagConfidence: 0.99 }, vocabulary, baseOpts);
assert.equal(r.newTag, null, 'tag restating the category must be rejected');

r = vetTags({ tags: [], confidence: 0.9, newTag: 'trader-joes', newTagConfidence: 0.99 }, vocabulary, baseOpts);
assert.equal(r.newTag, null, 'tag restating the payee must be rejected');

r = vetTags({ tags: [], confidence: 0.9, newTag: 'vacation', newTagConfidence: 0.85 }, vocabulary, baseOpts);
assert.equal(r.newTag, null, 'below new-tag threshold must be rejected');

r = vetTags({ tags: [], confidence: 0.9, newTag: 'vacation', newTagConfidence: 0.95 }, vocabulary, {
	...baseOpts,
	newTagBudget: 0,
});
assert.equal(r.newTag, null, 'exhausted budget must be rejected');

r = vetTags({ tags: [], confidence: 0.9, newTag: 'vacation', newTagConfidence: 0.95 }, vocabulary, baseOpts);
assert.equal(r.newTag, 'vacation', 'a genuinely new, confident tag is coined');

r = vetTags({ tags: ['groceries'], confidence: 0.5, newTag: '', newTagConfidence: 0 }, vocabulary, baseOpts);
assert.deepEqual(r.tags, [], 'low-confidence existing tags are dropped');

console.log('guardrails: all assertions passed');

// --- live stage 3 ---------------------------------------------------------

await checkModel();

const vocab = [
	{ tag: 'work-travel', count: 22 },
	{ tag: 'reimbursable', count: 14 },
	{ tag: 'subscription', count: 9 },
	{ tag: 'gift', count: 4 },
];

const cases = [
	{
		name: 'obvious existing tag',
		txn: { date: '2026-08-14', amount: -18400, imported_payee: 'DELTA AIR 0062419 ATL', notes: 'client onsite in Atlanta', _account: { name: 'Amex' } },
		category: 'Transport: Airfare',
	},
	{
		name: 'plain grocery run, expect no tag',
		txn: { date: '2026-08-14', amount: -6231, imported_payee: 'TRADER JOES #452', notes: null, _account: { name: 'Checking' } },
		category: 'Food: Groceries',
	},
	{
		name: 'recurring charge',
		txn: { date: '2026-08-14', amount: -1599, imported_payee: 'NETFLIX.COM MONTHLY', notes: null, _account: { name: 'Visa' } },
		category: 'Fun: Streaming',
	},
];

for (const c of cases) {
	const out = await suggestTags(c.txn, '', c.category, vocab, true);
	const vetted = vetTags(out, { set: new Set(vocab.map(v => v.tag)), tags: vocab }, {
		threshold: 0.8,
		newTagThreshold: 0.9,
		allowNew: true,
		newTagBudget: 3,
		categoryLabel: c.category,
		payeeName: c.txn.imported_payee,
	});
	console.log(
		`${c.name.padEnd(32)} raw=[${out.tags.join(',')}] new="${out.newTag}" (${out.newTagConfidence.toFixed(2)}) ` +
		`=> [${vetted.tags.join(',')}]${vetted.newTag ? ` +coin #${vetted.newTag}` : ''}` +
		(vetted.rejected.length ? `  rejected: ${vetted.rejected.map(x => x.why).join('; ')}` : ''),
	);
}
