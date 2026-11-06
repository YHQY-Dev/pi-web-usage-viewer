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

/** Uses only standard Pi dialogs and visible Markdown custom messages. */
export async function showUsageReport(
	pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string,
	collect: typeof collectUsageData = collectUsageData,
): Promise<void> {
	try {
		let query = args.trim();
		if (!query) {
			const options = Object.entries(REPORT_PERIODS).map(([key, label]) => `${label} (${key})`);
			const custom = "自定义时间范围";
			const selected = await ctx.ui.select("用量统计：选择时间范围（后端本地时间）", [...options, custom]);
			if (!selected) return;
			if (selected === custom) {
				const start = await ctx.ui.input("开始日期 / 时间（后端本地时间）", "YYYY-MM-DD 或 YYYY-MM-DDTHH:mm");
				if (!start?.trim()) return;
				const end = await ctx.ui.input("结束日期含当天；结束时刻不含", "YYYY-MM-DD 或 YYYY-MM-DDTHH:mm");
				if (!end?.trim()) return;
				query = `${start.trim()} ${end.trim()}`;
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
