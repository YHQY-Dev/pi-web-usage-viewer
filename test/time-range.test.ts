import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCustomRange, isInCustomRange } from "../time-range.ts";
import { collectUsageData } from "../data.ts";
import { buildGraphModel } from "../graph.ts";

test("date ranges include the entire ending day in the backend local timezone", () => {
	assert.equal(parseCustomRange(" "), undefined);
	const range = parseCustomRange("2026-11-01 2026-11-06")!;
	assert.equal(range.startMs, new Date(2026, 10, 1).getTime());
	assert.equal(range.endMs, new Date(2026, 10, 7).getTime());
	assert.ok(range.label.includes(Intl.DateTimeFormat().resolvedOptions().timeZone));
	assert.ok(isInCustomRange(range.startMs, range));
	assert.ok(isInCustomRange(range.endMs - 1, range));
	assert.ok(!isInCustomRange(range.endMs, range));
	assert.equal(parseCustomRange("2024-02-29 2024-02-29")!.endMs - parseCustomRange("2024-02-29 2024-02-29")!.startMs, 86400000);
});

test("calendar days follow DST rather than assuming 24 hours", () => {
	for (const date of ["2026-03-08", "2026-11-01"]) {
		const range = parseCustomRange(`${date} ${date}`)!;
		const start = new Date(range.startMs);
		const end = new Date(start);
		end.setDate(end.getDate() + 1);
		assert.equal(range.endMs, end.getTime());
		assert.equal(range.endMs - range.startMs,
			86400000 + (end.getTimezoneOffset() - start.getTimezoneOffset()) * 60000);
	}
	if (Intl.DateTimeFormat().resolvedOptions().timeZone === "America/Los_Angeles") {
		assert.equal(parseCustomRange("2026-03-08 2026-03-08")!.endMs - parseCustomRange("2026-03-08 2026-03-08")!.startMs, 23 * 3600000);
		assert.equal(parseCustomRange("2026-11-01 2026-11-01")!.endMs - parseCustomRange("2026-11-01 2026-11-01")!.startMs, 25 * 3600000);
		assert.throws(() => parseCustomRange("2026-03-08T02:30 2026-03-08T04:00"));
	}
});

test("minute precision is half-open and invalid inputs are rejected", () => {
	const range = parseCustomRange("2026-11-01T08:30 2026-11-01T09:15")!;
	assert.equal(range.endMs - range.startMs, 45 * 60000);
	for (const args of ["2026-02-29 2026-03-01", "2026-04-31 2026-05-01", "2026-01-01T24:00 2026-01-02", "2026-01-01T10:60 2026-01-02", "2026-11-07 2026-11-06", "2026-11-01T09:00 2026-11-01T09:00", "2026-1-1 2026-1-2", "today", "a b c"]) {
		assert.throws(() => parseCustomRange(args), Error, args);
	}
});

test("custom totals, model breakdown, graph and warm cache share exact boundaries", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-usage-range-"));
	try {
		const range = parseCustomRange("2026-11-01T08:30 2026-11-01T09:15")!;
		const entries: unknown[] = [{ type: "session", id: "range-test", cwd: "/test" }];
		const points = [
			[range.startMs - 1, 100, "model-a"], [range.startMs, 1, "model-a"],
			[range.startMs + 60000, 2, "model-b"], [range.endMs - 1, 3, "model-a"],
			[range.endMs, 200, "model-b"],
		] as const;
		for (const [timestamp, cost, model] of points) entries.push({
			type: "message", timestamp: new Date(timestamp).toISOString(),
			message: { role: "assistant", provider: "openai", model, timestamp,
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } },
		});
		entries.push({ type: "compaction", id: "summary", timestamp: new Date(range.startMs + 120000).toISOString(),
			usage: { input: 1, output: 1, cost: { total: 0.5 } } });
		await writeFile(join(dir, "session.jsonl"), entries.map(e => JSON.stringify(e)).join("\n") + "\n");
		const options = { sessionsDir: dir, cachePath: join(dir, "cache.json"), customRange: range, now: new Date("2026-11-07T00:00:00Z") };
		for (let pass = 0; pass < 2; pass++) {
			const data = (await collectUsageData(options))!;
			assert.equal(data.custom.totals.cost, 6.5);
			assert.equal(data.custom.totals.messages, 3);
			assert.equal(data.custom.totals.sessions, 1);
			assert.equal(data.custom.providers.get("openai")!.models.get("model-a")!.cost, 4);
			assert.equal(data.custom.providers.get("openai")!.models.get("model-b")!.cost, 2);
			assert.equal(data.allTime.totals.cost, 306.5);
			const graph = buildGraphModel(data.customHourly, { period: "custom", bounds: data.bounds,
				metric: "cost", groupBy: "model", cumulative: false });
			assert.equal(graph.series[0]!.points.reduce((sum, v) => sum + v, 0), 6.5);
		}
		const changed = (await collectUsageData({ ...options, customRange: parseCustomRange("2026-11-02 2026-11-02") }))!;
		assert.equal(changed.custom.totals.cost, 0);
		assert.equal(changed.customHourly.size, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
