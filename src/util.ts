// actual stores amounts as integer cents; negative is an outflow
export function toDollars(amount: number | null | undefined): string {
	if (amount == null) return '0.00';
	return (amount / 100).toFixed(2);
}

export function signedDollars(amount: number | null | undefined): string {
	const v = amount ?? 0;
	return `${v < 0 ? '-' : '+'}$${Math.abs(v / 100).toFixed(2)}`;
}

export function isoDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

export function daysAgo(n: number): Date {
	const d = new Date();
	d.setDate(d.getDate() - n);
	return d;
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// collapse a bank descriptor into a stable key: lowercase, drop store numbers,
// transaction ids and dates, squeeze whitespace
export function payeeKey(...parts: (string | null | undefined)[]): string {
	const raw = parts.filter(Boolean).join(' ');
	return raw
		.toLowerCase()
		.replace(/[#*]+/g, ' ')
		.replace(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, ' ')
		.replace(/\b[a-z]*\d[\w-]*\b/g, ' ') // any token containing a digit
		.replace(/[^a-z\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export function tokens(key: string): Set<string> {
	return new Set(key.split(' ').filter(t => t.length > 2));
}

// jaccard overlap, used to rank history examples for few-shot prompting
export function similarity(aTokens: Set<string>, bTokens: Set<string>): number {
	if (!aTokens.size || !bTokens.size) return 0;
	let shared = 0;
	for (const t of aTokens) if (bTokens.has(t)) shared++;
	return shared / (aTokens.size + bTokens.size - shared);
}

export function label(group: { name: string }, category: { name: string }): string {
	return `${group.name}: ${category.name}`;
}

export type Settled<R> =
	| { ok: true; value: R }
	| { ok: false; error: unknown };

// runs `fn` over `items` with at most `limit` in flight, yielding in the
// original order so output, the new-tag budget and the writes stay
// deterministic while the model calls overlap. Rejections are captured, not
// thrown, or a slow failure becomes an unhandled rejection while earlier items
// are still being consumed
export async function* mapOrderedConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): AsyncGenerator<{ item: T; index: number; result: Settled<R> }> {
	const width = Math.max(1, Math.floor(limit));
	const inFlight = new Map<number, Promise<Settled<R>>>();

	const start = (index: number) => {
		if (index >= items.length) return;
		const item = items[index] as T;
		inFlight.set(
			index,
			fn(item, index).then(
				value => ({ ok: true, value }) as const,
				error => ({ ok: false, error }) as const,
			),
		);
	};

	for (let i = 0; i < width; i++) start(i);

	for (let i = 0; i < items.length; i++) {
		const pending = inFlight.get(i);
		if (!pending) continue;
		const result = await pending;
		inFlight.delete(i);
		start(i + width);
		yield { item: items[i] as T, index: i, result };
	}
}
