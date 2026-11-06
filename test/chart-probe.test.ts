import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import chartProbe, { buildChartProbeMessage } from "../chart-probe.ts";

test("probe emits a self-contained SVG fence with explicitly synthetic data", () => {
	const message = buildChartProbeMessage();
	const match = /```svg\n([\s\S]+?)\n```/.exec(message);
	assert.ok(match);
	assert.ok(match[1]!.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
	assert.ok(match[1]!.endsWith("</svg>"));
	assert.equal((match[1]!.match(/<circle /g) ?? []).length, 7);
	assert.match(message, /模拟数据/);
	assert.match(message, /非真实用量/);
	assert.doesNotMatch(match[1]!, /<script|foreignObject|href=|\son\w+=/i);
});

test("test command sends a visible custom message without triggering a model turn", async () => {
	let handler: (() => Promise<void>) | undefined;
	const messages: unknown[] = [];
	const mock = {
		registerCommand(name: string, command: { handler: () => Promise<void> }) {
			assert.equal(name, "usage-chart-test");
			handler = command.handler;
		},
		sendMessage(message: unknown, options: unknown) {
			messages.push({ message, options });
		},
	};
	chartProbe(mock as unknown as ExtensionAPI);
	assert.ok(handler);
	await handler();
	assert.deepEqual(messages, [{
		message: { customType: "usage-chart-test", content: buildChartProbeMessage(), display: true },
		options: { triggerTurn: false },
	}]);
});
