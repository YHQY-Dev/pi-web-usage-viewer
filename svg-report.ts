import type { BaseStats, TabName, TimeFilteredStats, UsageData } from "./data.ts";

export const REPORT_PERIODS = {
	today: "今天", thisWeek: "本周", lastWeek: "上周", thisMonth: "本月",
	last30Days: "最近 30 天", allTime: "全部历史",
} as const;
export type ReportPeriod = keyof typeof REPORT_PERIODS;
export interface TrendPoint { startMs: number; cost: number }
export interface ModelRow extends BaseStats { provider: string; model: string }
export interface TrendSeries { label: string; total: number; points: TrendPoint[] }
export interface CostTrend {
	points: TrendPoint[]; series: TrendSeries[]; unit: string; startMs: number; endMs: number;
}

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
export function buildTrend(data: UsageData, period: TabName): CostTrend {
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
	const aggregate = (days: Map<number, number>): TrendPoint[] => {
		const bins = points.map((p) => ({ startMs: p.startMs, cost: 0 }));
		for (const [day, cost] of days) {
			// Shared calendar bins keep every model aligned with the total, including DST.
			let low = 0, high = bins.length;
			while (low < high) {
				const mid = (low + high) >>> 1;
				if (bins[mid]!.startMs <= day) low = mid + 1; else high = mid;
			}
			if (low > 0) bins[low - 1]!.cost += cost;
		}
		return bins;
	};
	const totalPoints = aggregate(daily);
	const series: TrendSeries[] = [{ label: "总额", total: data[period].totals.cost, points: totalPoints }];
	for (const row of modelRows(data[period])) {
		series.push({ label: `${row.provider} / ${row.model}`, total: row.cost,
			points: aggregate(data[period].dailyModelCosts.get(JSON.stringify([row.provider, row.model])) ?? new Map()) });
	}
	return { points: totalPoints, series, startMs: starts[period],
		endMs: Math.max(starts[period], endMs - 1, observed.at(-1) ?? 0),
		unit: dailyMode ? "每日" : monthStep === 1 ? "每月" : `每 ${monthStep} 个月` };
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

export function renderTrendSvg(trend: CostTrend, title: string, subtitle: string): string {
	const { points, series } = trend;
	const left = 100, top = 98, width = 800, height = 244;
	let peak = 0.001;
	for (const line of series) for (const p of line.points) peak = Math.max(peak, p.cost);
	const max = peak * 1.15;
	const palette = ["#14243b", "#2563eb", "#dc2626", "#059669", "#9333ea", "#d97706", "#0891b2", "#db2777"];
	const color = (i: number) => i < palette.length ? palette[i]! : `hsl(${(i * 137.508) % 360}, 65%, 38%)`;
	const dash = (i: number) => i === 0 ? "8 4" : i < palette.length ? "" : `${3 + i % 4} 3`;
	const x = (i: number) => left + (points.length <= 1 ? width / 2 : i * width / (points.length - 1));
	const y = (cost: number) => top + height - cost / max * height;
	const n = (v: number) => v.toFixed(2);
	const grid = Array.from({ length: 5 }, (_, i) => {
		const value = max * i / 4;
		return `<line x1="${left}" y1="${n(y(value))}" x2="${left + width}" y2="${n(y(value))}" stroke="#dbe3ed"/>
<text x="${left - 10}" y="${n(y(value) + 4)}" text-anchor="end" fill="#526175">${money(value)}</text>`;
	}).join("\n");
	const lines = series.map((line, s) => {
		const coords = line.points.map((p, i) => `${n(x(i))},${n(y(p.cost))}`).join(" ");
		const marks = line.points.map((p, i) => `<circle cx="${n(x(i))}" cy="${n(y(p.cost))}" r="${s === 0 ? 3 : 2.5}" fill="${color(s)}"/>`).join("");
		return `<polyline points="${coords}" fill="none" stroke="${color(s)}" stroke-width="${s === 0 ? 3 : 2}" stroke-dasharray="${dash(s)}" stroke-linejoin="round"/>${marks}`;
	}).reverse().join("\n");
	const labelEvery = Math.max(1, Math.ceil(points.length / 7));
	const labels = points.map((p, i) => i % labelEvery === 0 || i === points.length - 1
		? `<text x="${n(x(i))}" y="369" text-anchor="middle" fill="#526175" font-size="11">${dateLabel(p.startMs)}</text>` : "").join("\n");
	// Wrap long names rather than hiding model identities; legend grows with model count.
	let legendY = 405;
	const legend = series.map((line, i) => {
		const text = `${line.label}（${money(line.total)}）`;
		const chars = Array.from(text);
		const chunks: string[] = [];
		let chunk = "", units = 0;
		for (const char of chars) {
			const size = char.codePointAt(0)! > 255 ? 2 : 1;
			if (units + size > 105) { chunks.push(chunk); chunk = ""; units = 0; }
			chunk += char; units += size;
		}
		chunks.push(chunk);
		const y = legendY;
		legendY += chunks.length * 19 + 7;
		return `<line x1="30" y1="${y - 4}" x2="60" y2="${y - 4}" stroke="${color(i)}" stroke-width="${i === 0 ? 3 : 2}" stroke-dasharray="${dash(i)}"/>
${chunks.map((part, j) => `<text x="72" y="${y + j * 19}" fill="#14243b">${escapeXml(part)}</text>`).join("\n")}`;
	}).join("\n");
	return frame(title, subtitle, `${grid}\n${lines}\n${labels}\n${legend}`, legendY + 12);
}

export function buildUsageReport(data: UsageData, period: TabName): string {
	const stats = data[period];
	const label = period === "custom" ? "自定义范围" : REPORT_PERIODS[period];
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const rows = modelRows(stats);
	const trend = buildTrend(data, period);
	let range = `${dateLabel(trend.startMs)} 至 ${dateLabel(trend.endMs)}`;
	if (period === "custom" && data.bounds.customRange!.key.includes("T")) {
		const localTime = (ms: number) => `${dateLabel(ms)} ${new Date(ms).toTimeString().slice(0, 5)}`;
		range = `${localTime(trend.startMs)} 至 ${localTime(data.bounds.customRange!.endMs)}（结束时刻不含）`;
	}
	const rangeHint = "更换范围：`/usage today`、`/usage thisWeek`、`/usage lastWeek`、`/usage thisMonth`、`/usage last30Days`、`/usage allTime`，或 `/usage 2026-11-01 2026-11-06`。";
	const totals = stats.totals;
	const summary = `**费用 ${money(totals.cost)}** · Token ${count(totals.tokens.total)} · 缓存读取 ${count(totals.tokens.cacheRead)} · 助手消息 ${count(totals.messages)} · 会话 ${count(totals.sessions)}`;
	const header = `## 用量统计 · ${label}（${range}）\n\n时区：${markdown(timezone)} · 生成时间：${markdown(new Date(data.bounds.nowMs).toLocaleString())}\n\n${summary}`;
	if (!rows.length) return `${header}\n\n所选范围没有用量记录。\n\n${rangeHint}`;
	const table = ["| 服务商 / 模型 | 费用 USD | 输入 | 输出 | 缓存写入 | 缓存读取 | 助手消息 |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
		...rows.slice(0, 100).map((r) => `| ${markdown(r.provider)} / ${markdown(r.model)} | ${money(r.cost)} | ${count(r.tokens.input)} | ${count(r.tokens.output)} | ${count(r.tokens.cacheWrite)} | ${count(r.tokens.cacheRead)} | ${count(r.messages)} |`)];
	return `${header}\n\n${fence(renderTrendSvg(trend, `${trend.unit}费用趋势`, `${label} · ${range}`))}\n\n### 模型明细\n\n${table.join("\n")}${rows.length > 100 ? `\n\n仅列出费用最高的 100 行，共 ${rows.length} 行。` : ""}\n\n${rangeHint}`;
}
