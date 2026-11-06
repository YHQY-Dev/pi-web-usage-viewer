import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { collectUsageData } from "../data.ts";
import type { TimeFilteredStats, UsageData } from "../data.ts";
import { parseCustomRange } from "../time-range.ts";
import { buildTrend, buildUsageReport, modelRows, renderModelsSvg, escapeXml } from "../svg-report.ts";
import { parseReportArgs, showUsageReport } from "../report-command.ts";

function emptyStats(): TimeFilteredStats {
	return { dailyCosts: new Map(), providers: new Map(), totals: {
		cost: 0, messages: 0, sessions: 0, tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}, insights: { insights: [] } };
}
function fixture(rangeArgs = "2026-11-01 2026-11-03"): UsageData {
	const customRange = parseCustomRange(rangeArgs)!;
	return {
		bounds: { customRange, todayMs: customRange.startMs, weekStartMs: customRange.startMs,
			lastWeekStartMs: customRange.startMs - 7 * 86400000, thisMonthStartMs: customRange.startMs,
			last30DaysStartMs: customRange.startMs - 29 * 86400000, nowMs: customRange.endMs - 1 },
		today: emptyStats(), thisWeek: emptyStats(), lastWeek: emptyStats(), thisMonth: emptyStats(),
		last30Days: emptyStats(), allTime: emptyStats(), custom: emptyStats(), hourly: new Map(), customHourly: new Map(),
	};
}

test("report arguments accept preset or exact local custom range, reject invalid input", () => {
	assert.equal(parseReportArgs("  ").period, "thisWeek");
	assert.equal(parseReportArgs("last30Days").period, "last30Days");
	assert.equal(parseReportArgs("2026-11-01T08:30 2026-11-01T09:15").customRange!.endMs -
		parseReportArgs("2026-11-01T08:30 2026-11-01T09:15").customRange!.startMs, 45 * 60000);
	for (const args of ["unknown", "__proto__", "constructor", "2026-02-30 2026-03-01"]) assert.throws(() => parseReportArgs(args));
});

test("trend zero-fills local calendar days, including DST days", () => {
	const data = fixture();
	data.custom.dailyCosts.set(new Date(2026, 10, 1).getTime(), 2);
	data.custom.dailyCosts.set(new Date(2026, 10, 3).getTime(), 4);
	const trend = buildTrend(data, "custom");
	assert.equal(trend.unit, "每日");
	assert.deepEqual(trend.points.map((p) => p.cost), [2, 0, 4]);
	assert.deepEqual(trend.points.map((p) => new Date(p.startMs).getHours()), [0, 0, 0]);
	assert.deepEqual(trend.points.map((p) => new Date(p.startMs).getDate()), [1, 2, 3]);
});

test("long ranges aggregate calendar months into bounded SVG size without losing cost", () => {
	const data = fixture("2000-01-01 2099-12-31");
	for (const [date, cost] of [[new Date(2000, 0, 2), 1], [new Date(2050, 4, 1), 2], [new Date(2099, 11, 31), 3]] as const) {
		data.custom.dailyCosts.set(date.getTime(), cost);
	}
	const trend = buildTrend(data, "custom");
	assert.ok(trend.points.length <= 94);
	assert.match(trend.unit, /个月/);
	assert.equal(trend.points.reduce((s, p) => s + p.cost, 0), 6);
});

test("real collector daily buckets match post-dedupe totals across local midnight and warm cache", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-usage-svg-"));
	try {
		const range = parseCustomRange("2026-11-01T00:00 2026-11-03T00:00")!;
		const times = [range.startMs - 1, range.startMs, new Date(2026, 10, 2).getTime() - 1,
			new Date(2026, 10, 2).getTime(), range.endMs - 1, range.endMs];
		const entries: unknown[] = [{ type: "session", id: "svg-test", cwd: "/test" }];
		for (const [i, timestamp] of times.entries()) entries.push({
			type: "message", timestamp: new Date(timestamp).toISOString(),
			message: { role: "assistant", provider: "p<&|", model: "m\n```<script>", timestamp,
				usage: { input: 10, output: 5, cacheRead: 7, cacheWrite: 2, cost: { total: [100, 1, 2, 3, 4, 200][i] } } },
		});
		entries.push({ type: "compaction", id: "summary", timestamp: new Date(range.startMs + 60000).toISOString(),
			usage: { input: 1, output: 1, cost: { total: 0.5 } } });
		await writeFile(join(dir, "session.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
		for (let pass = 0; pass < 2; pass++) {
			const data = (await collectUsageData({ sessionsDir: dir, cachePath: join(dir, "cache.json"),
				customRange: range, now: new Date(range.endMs) }))!;
			assert.equal(data.custom.totals.cost, 10.5);
			assert.deepEqual([...data.custom.dailyCosts.values()], [3.5, 7]);
			assert.equal(buildTrend(data, "custom").points.reduce((s, p) => s + p.cost, 0), 10.5);
			assert.equal(modelRows(data.custom).reduce((s, r) => s + r.cost, 0), 10.5);
			const report = buildUsageReport(data, "custom");
			assert.equal((report.match(/```svg\n/g) ?? []).length, 2);
			assert.equal((report.match(/\n```/g) ?? []).length, 4);
			assert.match(report, /\$10\.5000/);
			assert.match(report, /p&lt;&amp;\|/);
			assert.doesNotMatch(report, /<script>/);
			assert.match(report, /&#124;/);
			assert.match(report, /Tools \/ summaries/);
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("empty report is explicit; zero-cost model charts remain finite; excess rows are grouped", () => {
	const data = fixture();
	assert.match(buildUsageReport(data, "custom"), /没有用量记录/);
	const stats = emptyStats();
	stats.providers.set("openai", { ...stats.totals, sessions: new Set(), models: new Map(
		Array.from({ length: 15 }, (_, i) => [`model-${i}`, { ...stats.totals, sessions: new Set() }]),
	) });
	const svg = renderModelsSvg(modelRows(stats));
	assert.match(svg, /其他 3 个模型/);
	assert.doesNotMatch(svg, /NaN|Infinity/);
	assert.equal(escapeXml('<script a="&">'), "&lt;script a=&quot;&amp;&quot;&gt;");
});

function mocks(selection?: string, inputs: (string | undefined)[] = []) {
	const messages: { content: string; display: boolean }[] = [];
	const options: unknown[] = [];
	const notifications: string[] = [];
	const pi = { sendMessage(message: typeof messages[number], opts: unknown) { messages.push(message); options.push(opts); } } as unknown as ExtensionAPI;
	const ctx = { ui: { select: async () => selection, input: async () => inputs.shift(),
		notify: (message: string) => notifications.push(message) } } as unknown as ExtensionCommandContext;
	return { pi, ctx, messages, options, notifications };
}

test("web report command supports presets, native range picker, and no model turn", async () => {
	for (const args of ["today", ""]) {
		const m = mocks("本周 (thisWeek)");
		let calls = 0;
		await showUsageReport(m.pi, m.ctx, args, async () => { calls++; return fixture(); });
		assert.equal(calls, 1);
		assert.equal(m.messages.length, 1);
		assert.equal(m.messages[0]!.display, true);
		assert.deepEqual(m.options, [{ triggerTurn: false }]);
	}
	const m = mocks("自定义时间范围", ["2026-11-01", "2026-11-03"]);
	await showUsageReport(m.pi, m.ctx, "", async (options) => {
		assert.equal(options!.customRange!.startMs, new Date(2026, 10, 1).getTime());
		return fixture();
	});
	assert.equal(m.messages.length, 1);
});

test("cancel/invalid range never scans, collector failure never appends stale report", async () => {
	for (const m of [mocks(), mocks("自定义时间范围", [undefined]), mocks("自定义时间范围", ["2026-11-01", undefined])]) {
		await showUsageReport(m.pi, m.ctx, "", async () => { assert.fail("must not scan"); });
		assert.equal(m.messages.length, 0);
	}
	const invalid = mocks();
	await showUsageReport(invalid.pi, invalid.ctx, "2026-02-30 2026-03-01", async () => { assert.fail("must not scan"); });
	assert.equal(invalid.messages.length, 0);
	assert.equal(invalid.notifications.length, 1);
	for (const collect of [async () => null, async () => { throw new Error("read failed"); }]) {
		const m = mocks();
		await showUsageReport(m.pi, m.ctx, "today", collect);
		assert.equal(m.messages.length, 0);
		assert.ok(m.notifications.length >= 2);
	}
});
