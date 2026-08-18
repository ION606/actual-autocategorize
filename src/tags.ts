import { api } from './actual.ts';
import type {
	OwnedTransaction,
	RejectedTag,
	TagSuggestion,
	TagVocabulary,
	TagVocabularyEntry,
	VetOptions,
	VettedTags,
} from './types.ts';

// in Actual a tag is a "#hashtag" inside a transaction's notes. The tags table
// is only a registry holding color and description; writing "#foo" into notes is
// what tags the transaction
export const TAG_RE = /#([a-z0-9][a-z0-9_-]*)/gi;
const VALID_SLUG = /^[a-z0-9][a-z0-9-]{1,23}$/;

export function extractTags(notes: string | null | undefined): string[] {
	if (!notes) return [];
	return [...notes.matchAll(TAG_RE)].map(m => (m[1] as string).toLowerCase());
}

export function normalizeTag(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const slug = String(raw)
		.trim()
		.replace(/^#+/, '')
		.toLowerCase()
		.replace(/[\s_]+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	return VALID_SLUG.test(slug) ? slug : null;
}

function levenshteinAtMost1(a: string, b: string): boolean {
	if (a === b) return true;
	if (Math.abs(a.length - b.length) > 1) return false;
	let i = 0,
		j = 0,
		edits = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			i++;
			j++;
			continue;
		}
		if (++edits > 1) return false;
		if (a.length > b.length) i++;
		else if (a.length < b.length) j++;
		else {
			i++;
			j++;
		}
	}
	return edits + (a.length - i) + (b.length - j) <= 1;
}

// crude stemmer. It is not meant to be right, only applied identically to both
// sides of a comparison
function stem(word: string): string {
	if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
	if (word.length > 3 && word.endsWith('es')) return word.slice(0, -2);
	if (word.length > 2 && word.endsWith('s')) return word.slice(0, -1);
	return word;
}

function stemSlug(slug: string): string {
	return slug.split('-').map(stem).join('-');
}

// catches a proposed tag that is an existing one restated: same word
// singular/plural, or one character away. Snap to the existing one instead of
// growing the vocabulary
export function findNearDuplicate(slug: string, existing: Iterable<string>): string | null {
	const stemmed = stemSlug(slug);
	for (const tag of existing) {
		if (tag === slug) return tag;
		const tagStem = stemSlug(tag);
		if (tagStem === stemmed) return tag;
		if (slug.length >= 5 && levenshteinAtMost1(slug, tag)) return tag;
		if (stemmed.length >= 5 && levenshteinAtMost1(stemmed, tagStem)) return tag;
	}
	return null;
}

// registered tags plus every tag in use in the notes of the history window, with
// counts so the prompt can lead with the common ones
export async function loadTagVocabulary(
	historyTxns: OwnedTransaction[],
): Promise<TagVocabulary> {
	const counts = new Map<string, number>();
	for (const t of historyTxns) {
		for (const tag of extractTags(t.notes)) {
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
		for (const sub of t.subtransactions ?? []) {
			for (const tag of extractTags(sub.notes)) {
				counts.set(tag, (counts.get(tag) ?? 0) + 1);
			}
		}
	}

	let registered: string[] = [];
	try {
		const tags = await getRegisteredTags();
		registered = tags.map(t => normalizeTag(t.tag)).filter((t): t is string => t !== null);
		for (const tag of registered) if (!counts.has(tag)) counts.set(tag, 0);
	} catch {
		// older API without the tags channel: notes scraping is enough
	}

	const ordered: TagVocabularyEntry[] = [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([tag, count]) => ({ tag, count }));

	return { tags: ordered, set: new Set(counts.keys()), registered: new Set(registered) };
}

async function getRegisteredTags(): Promise<{ tag: string }[]> {
	if (typeof api.getTags === 'function') return api.getTags();
	throw new Error('no tags channel');
}

// best effort. The hashtag in notes is what matters, so failing here is fine
export async function registerTag(tag: string): Promise<boolean> {
	try {
		if (typeof api.createTag === 'function') {
			await api.createTag({ tag });
			return true;
		}
	} catch {
		return false;
	}
	return false;
}

// turns the model's raw suggestion into what gets written. Every constraint on
// vocabulary growth is enforced here, not in the prompt
export function vetTags(
	suggestion: TagSuggestion,
	vocabulary: TagVocabulary,
	opts: VetOptions,
): VettedTags {
	const { threshold, newTagThreshold, allowNew, newTagBudget, categoryLabel, payeeName } = opts;

	const rejected: RejectedTag[] = [],
		result: VettedTags = { tags: [], newTag: null, rejected };

	if (suggestion.confidence >= threshold) {
		for (const raw of suggestion.tags) {
			const slug = normalizeTag(raw);
			if (!slug) continue;
			if (!vocabulary.set.has(slug)) {
				// the enum should prevent this. Treat it as noise
				rejected.push({ tag: raw, why: 'not an existing tag' });
				continue;
			}
			if (!result.tags.includes(slug)) result.tags.push(slug);
		}
	}

	if (!allowNew || !suggestion.newTag) return result;

	const reject = (why: string): VettedTags => {
		rejected.push({ tag: suggestion.newTag, why });
		return result;
	};

	if (newTagBudget <= 0) return reject('new-tag budget for this run is used up');
	if (suggestion.newTagConfidence < newTagThreshold) {
		return reject(`confidence ${suggestion.newTagConfidence.toFixed(2)} < ${newTagThreshold}`);
	}

	const slug = normalizeTag(suggestion.newTag);
	if (!slug) return reject('not a valid tag slug');

	if (vocabulary.set.has(slug)) {
		if (!result.tags.includes(slug)) result.tags.push(slug);
		return result;
	}

	const near = findNearDuplicate(slug, vocabulary.set);
	if (near) {
		if (!result.tags.includes(near)) result.tags.push(near);
		rejected.push({ tag: slug, why: `near-duplicate of existing "${near}"` });
		return result;
	}

	// a tag restating the category or the payee carries nothing new
	const categoryWords = new Set(
		(categoryLabel ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
	);
	const payeeWords = new Set(
		(payeeName || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
	);
	const slugWords = slug.split('-');
	if (slugWords.every(w => categoryWords.has(w) || categoryWords.has(w.replace(/s$/, '')))) {
		return reject('restates the category');
	}
	if (slugWords.every(w => payeeWords.has(w))) {
		return reject('restates the payee');
	}

	result.newTag = slug;
	result.tags.push(slug);
	return result;
}

// append tags without disturbing what is already in the notes
export function applyTagsToNotes(
	notes: string | null | undefined,
	tags: string[],
): string {
	const present = new Set(extractTags(notes));
	const additions = tags.filter(t => !present.has(t)).map(t => `#${t}`);
	if (!additions.length) return notes ?? '';
	return notes ? `${notes} ${additions.join(' ')}` : additions.join(' ');
}
