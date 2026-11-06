/** Custom ranges use the Pi backend's local timezone, just like preset periods. */
export interface CustomRange {
	startMs: number;
	endMs: number; // exclusive
	label: string;
	key: string;
}

function parseBoundary(value: string): { ms: number; dateOnly: boolean } {
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
	if (!match) throw new Error("日期格式须为 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm（Pi 后端本地时间）。");
	const [, year, month, day, hour = "00", minute = "00"] = match;
	const canonical = `${year}-${month}-${day}T${hour}:${minute}:00.000Z`;
	const wallTime = Date.parse(canonical);
	if (!Number.isFinite(wallTime) || new Date(wallTime).toISOString() !== canonical) {
		throw new Error(`无效日期或时间：${value}`);
	}
	const local = new Date(canonical.slice(0, -1));
	if (local.getFullYear() !== Number(year) || local.getMonth() !== Number(month) - 1 ||
		local.getDate() !== Number(day) || local.getHours() !== Number(hour) || local.getMinutes() !== Number(minute)) {
		throw new Error(`本地时区中不存在该日期或时间：${value}`);
	}
	return { ms: local.getTime(), dateOnly: match[4] === undefined };
}

export function parseCustomRange(args: string): CustomRange | undefined {
	if (!args.trim()) return undefined;
	const values = args.trim().split(/\s+/);
	if (values.length !== 2) throw new Error("用法：/usage <开始日期> <结束日期>，例如 /usage 2026-11-01 2026-11-06。");
	const start = parseBoundary(values[0]!);
	const end = parseBoundary(values[1]!);
	const endDate = new Date(end.ms);
	// Calendar arithmetic matches the preset periods, including DST transitions.
	if (end.dateOnly) endDate.setDate(endDate.getDate() + 1);
	const endMs = endDate.getTime();
	if (start.ms >= endMs) throw new Error("结束时间必须晚于开始时间；结束日期包含当天。");
	return {
		startMs: start.ms,
		endMs,
		label: `${values[0]} → ${values[1]} 后端本地时间（${Intl.DateTimeFormat().resolvedOptions().timeZone}）${end.dateOnly ? "（含结束日）" : "（不含结束时刻）"}`,
		key: `${values[0]}_${values[1]}`.replaceAll(":", "-"),
	};
}

export function isInCustomRange(timestamp: number, range: CustomRange): boolean {
	return timestamp >= range.startMs && timestamp < range.endMs;
}
