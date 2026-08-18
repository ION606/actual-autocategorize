import { api } from './actual.ts';

export interface LearnResult {
	created: boolean;
	why?: string;
}

// freeze a confident decision into a native Actual rule so the same payee never
// reaches the LLM again. Matches on payee id rather than a substring of the bank
// description, which would over-match
export async function learnRule(
	payeeId: string | null | undefined,
	categoryId: string | null | undefined,
): Promise<LearnResult> {
	if (!payeeId || !categoryId) return { created: false, why: 'missing payee or category' };

	const existing = await api.getPayeeRules(payeeId),
		alreadySetsCategory = existing.some(r =>
			(r.actions ?? []).some(a => 'field' in a && a.field === 'category' && a.op === 'set'),
		);

	if (alreadySetsCategory) return { created: false, why: 'rule already exists' };

	await api.createRule({
		stage: 'pre',
		conditionsOp: 'and',
		conditions: [{ field: 'payee', op: 'is', value: payeeId }],
		actions: [{ op: 'set', field: 'category', value: categoryId }],
	});
	return { created: true };
}
