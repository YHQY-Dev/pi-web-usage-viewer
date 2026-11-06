/** Minimal SVG transport probe; synthetic data only, no model or session scan. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function buildChartProbeMessage(): string {
	const values = [1.2, 2.8, 1.9, 4.1, 3.3, 5.2, 4.6];
	const left = 76;
	const top = 92;
	const width = 664;
	const height = 228;
	const maximum = 6;
	const point = (value: number, index: number) => ({
		x: left + index * width / (values.length - 1),
		y: top + height - value / maximum * height,
	});
	const grid = [0, 2, 4, 6].map((value) => {
		const y = top + height - value / maximum * height;
		return `<line x1="${left}" y1="${y}" x2="${left + width}" y2="${y}" stroke="#dbe3ed"/>
<text x="${left - 12}" y="${y + 5}" text-anchor="end" fill="#526175">$${value}</text>`;
	}).join("\n");
	const labels = values.map((value, index) => {
		const { x, y } = point(value, index);
		return `<circle cx="${x}" cy="${y}" r="5" fill="#2563eb"/>
<text x="${x}" y="${y - 13}" text-anchor="middle" fill="#1e40af">$${value.toFixed(2)}</text>
<text x="${x}" y="350" text-anchor="middle" fill="#526175">11-${String(index + 1).padStart(2, "0")}</text>`;
	}).join("\n");
	const points = values.map((value, index) => {
		const { x, y } = point(value, index);
		return `${x},${y}`;
	}).join(" ");
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400" viewBox="0 0 800 400" role="img" aria-labelledby="title desc">
<title id="title">用量折线图展示测试（示例数据）</title>
<desc id="desc">七天的模拟费用，仅验证 SVG 展示，不是真实账单。</desc>
<rect width="800" height="400" rx="16" fill="#f8fafc"/>
<g font-family="system-ui, sans-serif" font-size="14">
<text x="40" y="38" font-size="22" font-weight="700" fill="#14243b">每日费用趋势 · 示例数据</text>
<text x="40" y="65" fill="#526175">2026-11-01 — 2026-11-07 · USD · 非真实用量</text>
${grid}
<polyline points="${points}" fill="none" stroke="#2563eb" stroke-width="3" stroke-linejoin="round"/>
${labels}
<text x="40" y="383" font-size="12" fill="#526175">SVG 预览测试 · 无网络请求 · 无模型调用</text>
</g>
</svg>`;
	return `## 图表展示测试\n\n以下为**模拟数据**，不读取真实会话、不查询额度、不调用模型。\n\n\`\`\`svg\n${svg}\n\`\`\`\n\n如果显示为折线图，请点击图形，检查放大、缩放和下载；如果只看到代码，说明当前展示路径未启用 SVG 预览。`;
}

export default function chartProbe(pi: ExtensionAPI): void {
	pi.registerCommand("usage-chart-test", {
		description: "测试会话内 SVG 折线图预览（仅模拟数据，不调用模型）",
		handler: async () => {
			pi.sendMessage({
				customType: "usage-chart-test",
				content: buildChartProbeMessage(),
				display: true,
			}, { triggerTurn: false });
		},
	});
}
