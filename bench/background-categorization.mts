// Demonstrates the backgroundCategorization win: the awaited time on the
// tool-set-changed startup path drops from the full LLM latency to roughly
// zero when the categorization is deferred.
//
// The LLM call is stubbed to a fixed latency so the number measured is the
// removal of the await, not the model's speed. Run with:
//
//   ./node_modules/.bin/tsx bench/background-categorization.mts

import { runCategorizationMaybeDeferred } from "../lib/lib.js";

const LATENCY_MS = 200; // stand-in for real model latency (seconds in practice)
const ROUNDS = 5;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function measureAwaited(defer: boolean): Promise<number> {
	// Median of ROUNDS to shed scheduler noise.
	const samples: number[] = [];
	for (let i = 0; i < ROUNDS; i++) {
		const start = process.hrtime.bigint();
		await runCategorizationMaybeDeferred(defer, {
			applyCachedGroups: () => {
				// The cheap immediate grouping. Modelled as trivial work.
			},
			runCategorization: () => sleep(LATENCY_MS),
		});
		const end = process.hrtime.bigint();
		samples.push(Number(end - start) / 1e6); // ms
	}
	samples.sort((a, b) => a - b);
	return samples[Math.floor(samples.length / 2)]!;
}

const blocking = await measureAwaited(false);
const deferred = await measureAwaited(true);

// Let any deferred background work settle before exiting.
await sleep(LATENCY_MS + 50);

const fmt = (n: number) => n.toFixed(2);
console.log(`stubbed LLM latency:      ${LATENCY_MS} ms`);
console.log(`awaited (blocking):       ${fmt(blocking)} ms`);
console.log(`awaited (backgrounded):   ${fmt(deferred)} ms`);
console.log(`METRIC awaited_blocking_ms=${fmt(blocking)}`);
console.log(`METRIC awaited_deferred_ms=${fmt(deferred)}`);
