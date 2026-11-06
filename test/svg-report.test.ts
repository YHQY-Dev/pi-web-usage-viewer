import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { collectUsageData } from "../data.ts";
import type { TimeFilteredStats, UsageData } from "../data.ts";
import { parseCustomRange } from "../time-range.ts";
import { buildTrend, buildUsageReport, modelRows, renderTrendSvg, escapeXml } from "../svg-report.ts";
import { defaultWeekRange, parseReportArgs, showUsageReport } from "../report-command.ts";

function emptyStats(): TimeFilteredStats {
	return { dailyCosts: new Map(), dailyModelCosts: new Map(), providers: new Map(), totals: {
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
	data.custom.providers.set("p", { ...data.custom.totals, sessions: new Set(), models: new Map([
		["m", { ...data.custom.totals, cost: 6, sessions: new Set() }],
	]) });
	data.custom.totals.cost = 6;
	data.custom.dailyModelCosts.set(JSON.stringify(["p", "m"]), new Map(data.custom.dailyCosts));
	const trend = buildTrend(data, "custom");
	assert.deepEqual(trend.series[1]!.points, trend.points);
	assert.equal(trend.series[1]!.total, 6);
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
			assert.equal((report.match(/```svg\n/g) ?? []).length, 1);
			assert.equal((report.match(/\n```/g) ?? []).length, 2);
			const trend = buildTrend(data, "custom");
			assert.deepEqual(trend.series[1]!.points.map((p) => p.cost), [3, 7]);
			assert.deepEqual(trend.series[2]!.points.map((p) => p.cost), [0.5, 0]);
			assert.deepEqual(trend.series.map((s) => s.total), [10.5, 10, 0.5]);
			for (let i = 0; i < trend.points.length; i++) {
				assert.equal(trend.series.slice(1).reduce((sum, s) => sum + s.points[i]!.cost, 0), trend.points[i]!.cost);
			}
			assert.match(report, /总额（\$10\.5000）/);
			assert.match(report, /Tools \/ summaries（\$0\.5000）/);
			assert.doesNotMatch(report, /后端本地时区|各模型费用排行|Token 总量 =|费用来自本地会话|不支持悬停/);
			assert.match(report, /\$10\.5000/);
			assert.match(report, /p&lt;&amp;\|/);
			assert.doesNotMatch(report, /<script>/);
			assert.match(report, /&#124;/);
			assert.match(report, /Tools \/ summaries/);
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("empty report is explicit; zero-cost model lines stay finite and all legends are retained", () => {
	const data = fixture();
	assert.match(buildUsageReport(data, "custom"), /没有用量记录/);
	const stats = emptyStats();
	stats.providers.set("openai", { ...stats.totals, sessions: new Set(), models: new Map(
		Array.from({ length: 15 }, (_, i) => [`model-${i}`, { ...stats.totals, sessions: new Set() }]),
	) });
	data.custom = stats;
	const svg = renderTrendSvg(buildTrend(data, "custom"), "每日费用趋势", "test");
	assert.equal((svg.match(/<polyline /g) ?? []).length, 16);
	for (let i = 0; i < 15; i++) assert.ok(svg.includes(`openai / model-${i}（$0.0000）`));
	assert.doesNotMatch(svg, /NaN|Infinity/);
	assert.equal(escapeXml('<script a="&">'), "&lt;script a=&quot;&amp;&quot;&gt;");
});

test("report headings show actual dates and compact timezone, with only range help at the end", () => {
	const data = fixture();
	data.bounds = {
		...data.bounds, todayMs: new Date(2026, 10, 6).getTime(),
		weekStartMs: new Date(2026, 10, 2).getTime(), lastWeekStartMs: new Date(2026, 9, 26).getTime(),
		thisMonthStartMs: new Date(2026, 10, 1).getTime(), last30DaysStartMs: new Date(2026, 9, 8).getTime(),
		nowMs: new Date(2026, 10, 6, 16, 50).getTime(),
	};
	for (const [period, title] of [
		["today", "今天（2026-11-06 至 2026-11-06）"],
		["thisWeek", "本周（2026-11-02 至 2026-11-06）"],
		["lastWeek", "上周（2026-10-26 至 2026-11-01）"],
		["thisMonth", "本月（2026-11-01 至 2026-11-06）"],
		["last30Days", "最近 30 天（2026-10-08 至 2026-11-06）"],
		["custom", "自定义范围（2026-11-01 至 2026-11-03）"],
	] as const) {
		const report = buildUsageReport(data, period);
		assert.ok(report.startsWith(`## 用量统计 · ${title}\n\n时区：`));
		assert.ok(report.endsWith("或 `/usage 2026-11-01 2026-11-06`。"));
	}
	data.allTime.dailyCosts.set(new Date(2026, 9, 12).getTime(), 1);
	assert.ok(buildUsageReport(data, "allTime").startsWith("## 用量统计 · 全部历史（2026-10-12 至 2026-11-06）"));
	data.bounds.customRange = parseCustomRange("2026-11-01T08:30 2026-11-01T09:15")!;
	assert.ok(buildUsageReport(data, "custom").includes("2026-11-01 08:30 至 2026-11-01 09:15（结束时刻不含）"));
});

test("default range is backend-local Monday through today, including Sunday and year boundaries", () => {
	assert.equal(defaultWeekRange(new Date(2026, 10, 6, 17)), "2026-11-02 2026-11-06");
	assert.equal(defaultWeekRange(new Date(2026, 10, 2)), "2026-11-02 2026-11-02");
	assert.equal(defaultWeekRange(new Date(2026, 10, 8, 23, 59)), "2026-11-02 2026-11-08");
	assert.equal(defaultWeekRange(new Date(2027, 0, 1)), "2026-12-28 2027-01-01");
});

function mocks(selection?: string, inputs: (string | undefined)[] = []) {
	const messages: { content: string; display: boolean }[] = [];
	const options: unknown[] = [];
	const notifications: string[] = [];
	const pi = { sendMessage(message: typeof messages[number], opts: unknown) { messages.push(message); options.push(opts); } } as unknown as ExtensionAPI;
	const prefills: string[] = [];
	const ctx = { ui: { select: async () => selection, editor: async (_title: string, prefill: string) => {
		prefills.push(prefill);
		return inputs.shift();
	},
		notify: (message: string) => notifications.push(message) } } as unknown as ExtensionCommandContext;
	return { pi, ctx, messages, options, notifications, prefills };
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
	const m = mocks("设置范围", ["2026-11-01 2026-11-03"]);
	await showUsageReport(m.pi, m.ctx, "", async (options) => {
		assert.equal(options!.customRange!.startMs, new Date(2026, 10, 1).getTime());
		return fixture();
	});
	assert.equal(m.messages.length, 1);
	assert.deepEqual(m.prefills, [defaultWeekRange()]);
});

test("cancel/invalid range never scans, collector failure never appends stale report", async () => {
	for (const m of [mocks(), mocks("设置范围", [undefined]), mocks("设置范围", ["   "])]) {
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
