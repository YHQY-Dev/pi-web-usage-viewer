import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { collectUsageData } from "./data.ts";
import type { TabName } from "./data.ts";
import { parseCustomRange } from "./time-range.ts";
import type { CustomRange } from "./time-range.ts";
import { buildUsageReport, REPORT_PERIODS } from "./svg-report.ts";

export function parseReportArgs(args: string): { period: TabName; customRange?: CustomRange } {
	const value = args.trim();
	if (!value) return { period: "thisWeek" };
	if (Object.hasOwn(REPORT_PERIODS, value)) return { period: value as keyof typeof REPORT_PERIODS };
	return { period: "custom", customRange: parseCustomRange(value)! };
}

export function defaultWeekRange(now: Date = new Date()): string {
	const monday = new Date(now);
	monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
	const date = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	return `${date(monday)} ${date(now)}`;
}

/** Uses only standard Pi dialogs and visible Markdown custom messages. */
export async function showUsageReport(
	pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string,
	collect: typeof collectUsageData = collectUsageData,
): Promise<void> {
	try {
		let query = args.trim();
		if (!query) {
			const options = Object.entries(REPORT_PERIODS).map(([key, label]) => `${label} (${key})`);
			const custom = "设置范围";
			const selected = await ctx.ui.select("用量统计：选择时间范围（后端本地时间）", [...options, custom]);
			if (!selected) return;
			if (selected === custom) {
				const range = await ctx.ui.editor(
					"设置范围：起止时间用空格分隔（本地时间，默认本周一至今天）",
					defaultWeekRange(),
				);
				if (!range?.trim()) return;
				query = range.trim();
			} else {
				query = Object.keys(REPORT_PERIODS)[options.indexOf(selected)]!;
			}
		}
		const { period, customRange } = parseReportArgs(query);
		ctx.ui.notify("正在读取本地用量记录…", "info");
		const data = await collect({ customRange });
		if (!data) {
			ctx.ui.notify("未能读取用量记录，请重试。", "warning");
			return;
		}
		pi.sendMessage({ customType: "usage-report", content: buildUsageReport(data, period), display: true }, { triggerTurn: false });
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}
