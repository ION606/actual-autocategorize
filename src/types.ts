import type api from '@actual-app/api';

// derived from the installed package's own signatures so they track whatever
// version is installed instead of drifting against a hand-written copy
type Unwrap<T> = T extends (...args: never[]) => Promise<infer R> ? R : never;
type Element<T> = T extends readonly (infer E)[] ? E : never;

export type Account = Element<Unwrap<typeof api.getAccounts>>;
export type Payee = Element<Unwrap<typeof api.getPayees>>;
export type CategoryGroup = Element<Unwrap<typeof api.getCategoryGroups>>;
export type Category = Element<Unwrap<typeof api.getCategories>>;
export type Transaction = Element<Unwrap<typeof api.getTransactions>>;
export type Rule = Element<Unwrap<typeof api.getRules>>;
export type Tag = Element<Unwrap<typeof api.getTags>>;

export type OwnedTransaction = Transaction & { _account: Account };

export interface TaxonomyGroup {
	id: string;
	name: string;
	is_income: boolean;
	categories: Category[];
}

export interface CategoryMeta {
	group: TaxonomyGroup;
	category: Category;
	label: string;
}

export interface Taxonomy {
	groups: TaxonomyGroup[];
	/** "Group: Category" -> category id */
	byLabel: Map<string, string>;
	byCategoryId: Map<string, CategoryMeta>;
}

export interface HistoryExample {
	key: string;
	tokens: Set<string>;
	label: string;
	amount: number;
	payeeName: string;
}

export interface History {
	/** lookup key -> (category id -> vote count) */
	votes: Map<string, Map<string, number>>;
	examples: HistoryExample[];
}

export interface HistoryHit {
	categoryId: string;
	confidence: number;
	count: number;
	total: number;
	key: string;
}

export type DecisionSource = 'history' | 'llm';

export interface Decision {
	source: DecisionSource;
	confidence: number;
	categoryId?: string;
	label?: string;
	reason?: string;
	/** Set instead of categoryId when the model declined to answer */
	abstained?: string;
	error?: string;
	groupConfidence?: number;
	categoryConfidence?: number;
}

export interface TagVocabularyEntry {
	tag: string;
	count: number;
}

export interface TagVocabulary {
	tags: TagVocabularyEntry[];
	set: Set<string>;
	registered: Set<string>;
}

export interface TagSuggestion {
	tags: string[];
	confidence: number;
	newTag: string;
	newTagConfidence: number;
}

export interface RejectedTag {
	tag: string | null;
	why: string;
}

export interface VettedTags {
	tags: string[];
	newTag: string | null;
	rejected: RejectedTag[];
}

export interface VetOptions {
	threshold: number;
	newTagThreshold: number;
	allowNew: boolean;
	newTagBudget: number;
	categoryLabel: string | undefined;
	payeeName: string;
}
