import { config } from './config.ts';
import { signedDollars } from './util.ts';
import type {
	Decision,
	HistoryExample,
	OwnedTransaction,
	TagSuggestion,
	TagVocabularyEntry,
	Taxonomy,
	TaxonomyGroup,
} from './types.ts';

export const UNSURE = 'UNSURE';

interface JsonSchema {
	type: string;
	properties: Record<string, unknown>;
	required: string[];
}

interface ChatArgs {
	system: string;
	user: string;
	schema: JsonSchema;
	timeoutMs?: number;
}

async function chat<T>({ system, user, schema, timeoutMs = 120000 }: ChatArgs): Promise<T> {
	const controller = new AbortController(),
		timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const res = await fetch(`${config.ollamaUrl}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: config.model,
				stream: false,
				format: schema,
				options: { temperature: 0, num_ctx: 8192 },
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: user },
				],
			}),
			signal: controller.signal,
		});

		if (!res.ok) {
			throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
		}

		const body = (await res.json()) as { message?: { content?: string } },
			content = body?.message?.content;

		if (!content) throw new Error('ollama returned an empty message');
		return JSON.parse(content) as T;
	} finally {
		clearTimeout(timer);
	}
}

function describe(txn: OwnedTransaction, payeeName: string): string {
	const amount = txn.amount ?? 0,
		lines = [
			`Date: ${txn.date}`,
			`Amount: ${signedDollars(amount)} (${amount < 0 ? 'money out' : 'money in'})`,
			`Account: ${txn._account?.name ?? 'unknown'}`,
		];

	if (payeeName) lines.push(`Payee: ${payeeName}`);
	if (txn.imported_payee) lines.push(`Bank description: ${txn.imported_payee}`);
	if (txn.notes) lines.push(`Notes: ${txn.notes}`);

	return lines.join('\n');
}

function exampleBlock(examples: HistoryExample[]): string {
	if (!examples.length) return '';
	const rows = examples
		.map(e => `- "${e.payeeName}" ${signedDollars(e.amount)} -> ${e.label}`)
		.join('\n');

	return `\nSimilar transactions this user categorized before:\n${rows}\n`;
}

const SYSTEM =
	'You categorize personal bank transactions for a budgeting app. ' +
	'Answer only with one of the offered options. ' +
	`Pick ${UNSURE} when the transaction genuinely does not fit any option, ` +
	'rather than guessing. Confidence is your own probability that the answer is ' +
	'correct, between 0 and 1.';

// stage 1: which group?
async function pickGroup(
	txn: OwnedTransaction,
	payeeName: string,
	groups: TaxonomyGroup[],
	examples: HistoryExample[],
): Promise<{ group: string; confidence: number }> {
	const options = groups.map(g => {
		const preview = g.categories
			.slice(0, 8)
			.map(c => c.name)
			.join(', ');
		return `- ${g.name}${g.is_income ? ' (income)' : ''}: ${preview}`;
	});

	const schema: JsonSchema = {
		type: 'object',
		properties: {
			group: { type: 'string', enum: [...groups.map(g => g.name), UNSURE] },
			confidence: { type: 'number' },
		},
		required: ['group', 'confidence'],
	};

	const user =
		`Transaction:\n${describe(txn, payeeName)}\n` +
		exampleBlock(examples) +
		`\nCategory groups (name: some categories inside it):\n${options.join('\n')}\n` +
		'\nWhich group does this transaction belong to?';

	const out = await chat<{ group: string; confidence: unknown }>({ system: SYSTEM, user, schema });
	return { group: out.group, confidence: clamp(out.confidence) };
}

// stage 2: which category inside that group?
async function pickCategory(
	txn: OwnedTransaction,
	payeeName: string,
	group: TaxonomyGroup,
	examples: HistoryExample[],
): Promise<{ category: string; confidence: number; reason: string }> {
	const names = group.categories.map(c => c.name),
		schema: JsonSchema = {
			type: 'object',
			properties: {
				category: { type: 'string', enum: [...names, UNSURE] },
				confidence: { type: 'number' },
				reason: { type: 'string' },
			},
			required: ['category', 'confidence', 'reason'],
		};

	const user =
		`Transaction:\n${describe(txn, payeeName)}\n` +
		exampleBlock(examples.filter(e => e.label.startsWith(`${group.name}: `))) +
		`\nThis transaction belongs to the "${group.name}" group. ` +
		`Categories in that group:\n${names.map(n => `- ${n}`).join('\n')}\n` +
		'\nWhich category fits best? Keep the reason under 15 words.';

	const out = await chat<{ category: string; confidence: unknown; reason?: string }>({
		system: SYSTEM,
		user,
		schema,
	});

	return {
		category: out.category,
		confidence: clamp(out.confidence),
		reason: (out.reason || '').slice(0, 120),
	};
}

function clamp(n: unknown): number {
	const v = Number(n);
	if (!Number.isFinite(v)) return 0;
	return Math.max(0, Math.min(1, v));
}

// tier 3. Abstains instead of guessing when either stage is unsure
export async function classify(
	txn: OwnedTransaction,
	payeeName: string,
	taxonomy: Taxonomy,
	examples: HistoryExample[],
): Promise<Decision> {
	const stage1 = await pickGroup(txn, payeeName, taxonomy.groups, examples);
	if (stage1.group === UNSURE) {
		return { source: 'llm', abstained: 'group', confidence: stage1.confidence };
	}

	const group = taxonomy.groups.find(g => g.name === stage1.group);
	if (!group) {
		return { source: 'llm', abstained: 'group-not-found', confidence: 0 };
	}

	const stage2 = await pickCategory(txn, payeeName, group, examples);
	if (stage2.category === UNSURE) {
		return {
			source: 'llm',
			abstained: 'category',
			confidence: stage1.confidence * stage2.confidence,
		};
	}

	const labelStr = `${group.name}: ${stage2.category}`,
		categoryId = taxonomy.byLabel.get(labelStr);

	if (!categoryId) {
		// the enum should make this impossible. Abstain rather than write a
		// wrong id
		return { source: 'llm', abstained: 'unknown-label', confidence: 0, label: labelStr };
	}

	return {
		source: 'llm',
		categoryId,
		label: labelStr,
		groupConfidence: stage1.confidence,
		categoryConfidence: stage2.confidence,
		confidence: stage1.confidence * stage2.confidence,
		reason: stage2.reason,
	};
}

// stage 3, optional. Existing tags are enum-constrained; a new tag is free text,
// so its guardrails live in tags.ts rather than in the prompt
export async function suggestTags(
	txn: OwnedTransaction,
	payeeName: string,
	categoryLabel: string | undefined,
	vocabulary: TagVocabularyEntry[],
	allowNew: boolean,
): Promise<TagSuggestion> {
	const known = vocabulary.map(v => v.tag);

	const properties: Record<string, unknown> = {
		tags: {
			type: 'array',
			items: known.length ? { type: 'string', enum: known } : { type: 'string' },
			maxItems: 2,
		},
		confidence: { type: 'number' },
	},
		required = ['tags', 'confidence'];

	if (allowNew) {
		properties.new_tag = { type: 'string' };
		properties.new_tag_confidence = { type: 'number' };
		required.push('new_tag', 'new_tag_confidence');
	}

	const vocabLine = known.length
		? vocabulary.map(v => `- ${v.tag}${v.count ? ` (used ${v.count}x)` : ''}`).join('\n')
		: '(no tags exist yet)';

	const user =
		`Transaction:\n${describe(txn, payeeName)}\n` +
		`Category already assigned: ${categoryLabel ?? 'unknown'}\n` +
		`\nExisting tags:\n${vocabLine}\n` +
		'\nPick 0 to 2 existing tags that add information the category does not ' +
		'already carry. Most transactions need no tag at all - an empty list is a ' +
		'good answer.' +
		(allowNew
			? '\n\nIf, and only if, this transaction represents a recurring theme that ' +
			'none of the existing tags covers, propose one new tag in "new_tag": ' +
			'lowercase, hyphenated, one or two words, reusable across many future ' +
			'transactions. Never propose a tag that restates the category, the ' +
			'payee name, or the amount. Otherwise set "new_tag" to an empty string.'
			: '');

	const out = await chat<{
		tags?: unknown;
		confidence: unknown;
		new_tag?: string;
		new_tag_confidence?: unknown;
	}>({
		system: SYSTEM,
		user,
		schema: { type: 'object', properties, required },
	});

	return {
		tags: Array.isArray(out.tags) ? (out.tags as string[]).slice(0, 2) : [],
		confidence: clamp(out.confidence),
		newTag: allowNew ? (out.new_tag || '').trim() : '',
		newTagConfidence: allowNew ? clamp(out.new_tag_confidence) : 0,
	};
}

export async function checkModel(): Promise<void> {
	const res = await fetch(`${config.ollamaUrl}/api/tags`).catch(() => null);
	if (!res || !res.ok) {
		throw new Error(`Cannot reach ollama at ${config.ollamaUrl}. Is it running?`);
	}

	const { models = [] } = (await res.json()) as { models?: { name: string }[] },
		names = models.map(m => m.name);
	if (!names.includes(config.model) && !names.includes(`${config.model}:latest`)) {
		throw new Error(
			`Model "${config.model}" not pulled. Available: ${names.join(', ') || '(none)'}`,
		);
	}
}
