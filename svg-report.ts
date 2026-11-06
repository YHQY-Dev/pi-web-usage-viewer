import type { BaseStats, TabName, TimeFilteredStats, UsageData } from "./data.ts";

export const REPORT_PERIODS = {
	today: "今天", thisWeek: "本周", lastWeek: "上周", thisMonth: "本月",
	last30Days: "最近 30 天", allTime: "全部历史",
} as const;
export type ReportPeriod = keyof typeof REPORT_PERIODS;
export interface TrendPoint { startMs: number; cost: number }
export interface ModelRow extends BaseStats { provider: string; model: string }

export function escapeXml(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[&<>"'`]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;", "`": "&#96;" })[c]!);
}
function markdown(value: string): string {
	return value.replace(/[\r\n\t]/g, " ").replace(/[\\`*_{}\[\]()#+.!|<>~&]/g, (c) => `&#${c.charCodeAt(0)};`);
}
function money(value: number): string { return `$${value.toFixed(4)}`; }
function count(value: number): string { return value.toLocaleString("en-US"); }
function dateLabel(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function localDay(ms: number): Date { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d; }

/** Calendar-based bins, not UTC-hour approximations: includes DST and half-hour zones. */
export function buildTrend(data: UsageData, period: TabName): { points: TrendPoint[]; unit: string } {
	const bounds = data.bounds;
	const daily = data[period].dailyCosts;
	const observed = [...daily.keys()].sort((a, b) => a - b);
	const starts = {
		today: bounds.todayMs, thisWeek: bounds.weekStartMs, lastWeek: bounds.lastWeekStartMs,
		thisMonth: bounds.thisMonthStartMs, last30Days: bounds.last30DaysStartMs,
		allTime: observed[0] ?? bounds.todayMs, custom: bounds.customRange?.startMs ?? bounds.todayMs,
	};
	const start = localDay(starts[period]);
	const endMs = period === "custom" ? bounds.customRange!.endMs
		: period === "lastWeek" ? bounds.weekStartMs : bounds.nowMs;
	// Observed days keep the trend aligned with the same totals, including future-dated logs.
	const last = localDay(Math.max(starts[period], endMs - 1, observed.at(-1) ?? 0));
	const dailyMode = (last.getTime() - start.getTime()) / 86400000 < 93;
	const monthCount = (last.getFullYear() - start.getFullYear()) * 12 + last.getMonth() - start.getMonth() + 1;
	const monthStep = Math.max(1, Math.ceil(monthCount / 93));
	const points: TrendPoint[] = [];
	const cursor = new Date(start);
	if (!dailyMode) cursor.setDate(1);
	while (cursor <= last) {
		points.push({ startMs: cursor.getTime(), cost: 0 });
		if (dailyMode) cursor.setDate(cursor.getDate() + 1);
		else cursor.setMonth(cursor.getMonth() + monthStep);
	}
	for (const [day, cost] of daily) {
		// There are at most ~94 bins. Binary search also handles non-24-hour days.
		let low = 0;
		let high = points.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (points[mid]!.startMs <= day) low = mid + 1; else high = mid;
		}
		if (low > 0) points[low - 1]!.cost += cost;
	}
	return { points, unit: dailyMode ? "每日" : monthStep === 1 ? "每月" : `每 ${monthStep} 个月` };
}

export function modelRows(stats: TimeFilteredStats): ModelRow[] {
	return [...stats.providers].flatMap(([provider, s]) => [...s.models].map(([model, row]) => ({ provider, model, ...row })))
		.sort((a, b) => b.cost - a.cost || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

function frame(title: string, subtitle: string, body: string, height = 420): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${height}" viewBox="0 0 960 ${height}" role="img" aria-labelledby="title">
<title id="title">${escapeXml(title)}</title>
<rect width="960" height="${height}" rx="14" fill="#f8fafc"/>
<g font-family="system-ui, sans-serif" font-size="13">
<text x="28" y="34" font-size="21" font-weight="700" fill="#14243b">${escapeXml(title)}</text>
<text x="28" y="60" fill="#526175">${escapeXml(subtitle)}</text>
${body}
</g></svg>`;
}
function fence(svg: string): string { return `\`\`\`svg\n${svg}\n\`\`\``; }

export function renderTrendSvg(points: TrendPoint[], title: string, subtitle: string): string {
	const left = 90, top = 98, width = 820, height = 244;
	const max = Math.max(0.001, ...points.map((p) => p.cost)) * 1.15;
	const x = (i: number) => left + (points.length <= 1 ? width / 2 : i * width / (points.length - 1));
	const y = (cost: number) => top + height - cost / max * height;
	const n = (v: number) => v.toFixed(2);
	const grid = Array.from({ length: 5 }, (_, i) => {
		const value = max * i / 4;
		return `<line x1="${left}" y1="${n(y(value))}" x2="${left + width}" y2="${n(y(value))}" stroke="#dbe3ed"/>
<text x="${left - 10}" y="${n(y(value) + 4)}" text-anchor="end" fill="#526175">${money(value)}</text>`;
	}).join("\n");
	const polyline = points.map((p, i) => `${n(x(i))},${n(y(p.cost))}`).join(" ");
	const labelEvery = Math.max(1, Math.ceil(points.length / 7));
	const marks = points.map((p, i) => {
		const label = i % labelEvery === 0 || i === points.length - 1;
		return `<circle cx="${n(x(i))}" cy="${n(y(p.cost))}" r="3" fill="#2563eb"/>
${label ? `<text x="${n(x(i))}" y="369" text-anchor="middle" fill="#526175" font-size="11">${dateLabel(p.startMs)}</text>` : ""}
${points.length <= 12 ? `<text x="${n(x(i))}" y="${n(y(p.cost) - 10)}" text-anchor="middle" fill="#1e40af" font-size="11">${money(p.cost)}</text>` : ""}`;
	}).join("\n");
	return frame(title, subtitle, `${grid}<polyline points="${polyline}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linejoin="round"/>${marks}
<text x="28" y="404" fill="#526175" font-size="12">USD · 本地记录费用，不是订阅账单 · 点击可放大查看</text>`);
}

export function renderModelsSvg(rows: ModelRow[]): string {
	const kept = rows.slice(0, 12).map((r) => ({ label: `${r.provider} / ${r.model}`, cost: r.cost }));
	if (rows.length > 12) kept.push({ label: `其他 ${rows.length - 12} 个模型`, cost: rows.slice(12).reduce((s, r) => s + r.cost, 0) });
	const max = Math.max(0.001, ...kept.map((r) => r.cost));
	const bars = kept.map((r, i) => {
		const label = r.label.length > 42 ? `${r.label.slice(0, 39)}…` : r.label;
		const y = 89 + i * 34;
		return `<text x="335" y="${y + 15}" text-anchor="end" fill="#14243b" font-size="12">${escapeXml(label)}</text>
<rect x="350" y="${y}" width="${Math.max(0, r.cost / max * 450).toFixed(2)}" height="21" rx="3" fill="#2563eb"/>
<text x="${(365 + Math.max(0, r.cost / max * 450)).toFixed(2)}" y="${y + 15}" fill="#1e40af">${money(r.cost)}</text>`;
	}).join("\n");
	return frame("各模型费用排行", "按服务商 / 模型区分 · 前 12 名，其余合并；完整名称见下方表格", bars, Math.max(160, 120 + kept.length * 34));
}

export function buildUsageReport(data: UsageData, period: TabName): string {
	const stats = data[period];
	const label = period === "custom" ? data.bounds.customRange!.label : REPORT_PERIODS[period];
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const rows = modelRows(stats);
	const trend = buildTrend(data, period);
	const datedCost = [...stats.dailyCosts.values()].reduce((a, b) => a + b, 0);
	const totals = stats.totals;
	const summary = `**费用 ${money(totals.cost)}** · Token ${count(totals.tokens.total)} · 缓存读取 ${count(totals.tokens.cacheRead)} · 助手消息 ${count(totals.messages)} · 会话 ${count(totals.sessions)}`;
	const header = `## 用量统计 · ${label}\n\n后端本地时区：${markdown(timezone)} · 生成时间：${markdown(new Date(data.bounds.nowMs).toLocaleString())}\n\n${summary}`;
	if (!rows.length) return `${header}\n\n所选范围没有用量记录。\n\n更换范围：\`/usage thisWeek\`、\`/usage thisMonth\` 或 \`/usage 开始日期 结束日期\`。`;
	const table = ["| 服务商 / 模型 | 费用 USD | 输入 | 输出 | 缓存写入 | 缓存读取 | 助手消息 |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
		...rows.slice(0, 100).map((r) => `| ${markdown(r.provider)} / ${markdown(r.model)} | ${money(r.cost)} | ${count(r.tokens.input)} | ${count(r.tokens.output)} | ${count(r.tokens.cacheWrite)} | ${count(r.tokens.cacheRead)} | ${count(r.messages)} |`)];
	return `${header}\n\n${fence(renderTrendSvg(trend.points, `${trend.unit}费用趋势`, `${label} · ${timezone}`))}\n\n${fence(renderModelsSvg(rows))}\n\n### 模型明细\n\n${table.join("\n")}${rows.length > 100 ? `\n\n仅列出费用最高的 100 行，共 ${rows.length} 行。` : ""}\n\nToken 总量 = 输入 + 输出 + 缓存写入；缓存读取单列。工具和摘要用量沿用原统计口径，可能显示为 Tools / summaries。${Math.abs(totals.cost - datedCost) > 0.000001 ? ` 有 ${money(totals.cost - datedCost)} 的费用缺少有效时间戳，计入总额但未画入趋势图。` : ""}\n\n费用来自本地会话记录，不等于订阅实际账单。图表为静态 SVG，可放大、缩放和下载，不支持悬停交互。\n\n更换范围：\`/usage today\`、\`/usage thisWeek\`、\`/usage lastWeek\`、\`/usage thisMonth\`、\`/usage last30Days\`、\`/usage allTime\`，或 \`/usage 2026-11-01 2026-11-06\`。`;
}
