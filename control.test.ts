import test from "node:test";
import assert from "node:assert/strict";
import { BOSS_CONTROL_ENVELOPE_VERSION } from "@dataforxyz/agent-intercom-core/boss";
import {
	intercomControlKey,
	isIntercomCommonControlEnvelope,
	isIntercomControlEnvelope,
	parseIntercomControlRegistration,
	parseIntercomControlSendRequest,
} from "./control.ts";

test("structured intercom controls validate bounded typed envelopes", () => {
	const control = { type: "reload-runtime.request", version: 1, data: { requestId: "request-1" } };
	assert.equal(isIntercomControlEnvelope(control), true);
	assert.equal(intercomControlKey(control), "reload-runtime.request@1");
	assert.deepEqual(parseIntercomControlRegistration(control), {
		type: "reload-runtime.request",
		version: 1,
	});

	assert.equal(isIntercomControlEnvelope({ type: "", version: 1 }), false);
	assert.equal(isIntercomControlEnvelope({ type: "bad type", version: 1 }), false);
	assert.equal(isIntercomControlEnvelope({ type: "reload", version: 0 }), false);
	assert.equal(isIntercomControlEnvelope({
		type: "reload",
		version: 1,
		data: "x".repeat(17 * 1024),
	}), false);
});

test("control send requests require correlation and target fields", () => {
	assert.deepEqual(parseIntercomControlSendRequest({
		requestId: "delivery-1",
		to: "worker",
		messageId: "message-1",
		fallbackText: "Compatible reload extension required.",
		control: { type: "reload-runtime.request", version: 1, data: { requestId: "reload-1" } },
	}), {
		requestId: "delivery-1",
		to: "worker",
		messageId: "message-1",
		fallbackText: "Compatible reload extension required.",
		control: { type: "reload-runtime.request", version: 1, data: { requestId: "reload-1" } },
	});
	assert.equal(parseIntercomControlSendRequest({
		requestId: "",
		to: "worker",
		control: { type: "reload", version: 1 },
	}), null);
});

test("control-send outer wrappers reject proxies and accessors without side effects", () => {
	const request = {
		requestId: "delivery-1",
		to: "worker",
		control: { type: "reload-runtime.request", version: 1 },
	};
	let proxyTraps = 0;
	const proxy = new Proxy(request, {
		get() {
			proxyTraps += 1;
			throw new Error("proxy trap must not execute");
		},
		getOwnPropertyDescriptor() {
			proxyTraps += 1;
			throw new Error("proxy trap must not execute");
		},
		getPrototypeOf() {
			proxyTraps += 1;
			throw new Error("proxy trap must not execute");
		},
		ownKeys() {
			proxyTraps += 1;
			throw new Error("proxy trap must not execute");
		},
	});
	assert.equal(parseIntercomControlSendRequest(proxy), null);
	assert.equal(proxyTraps, 0);
	assert.equal(parseIntercomControlRegistration(proxy), null);
	assert.equal(proxyTraps, 0);

	let nestedProxyTraps = 0;
	const nestedProxy = new Proxy(request.control, {
		get() {
			nestedProxyTraps += 1;
			throw new Error("nested proxy trap must not execute");
		},
		ownKeys() {
			nestedProxyTraps += 1;
			throw new Error("nested proxy trap must not execute");
		},
	});
	assert.equal(parseIntercomControlSendRequest({ ...request, control: nestedProxy }), null);
	assert.equal(nestedProxyTraps, 0);

	let accessorCalls = 0;
	const accessor = Object.defineProperty({ ...request }, "to", {
		enumerable: true,
		get() {
			accessorCalls += 1;
			return "worker";
		},
	});
	assert.equal(parseIntercomControlSendRequest(accessor), null);
	assert.equal(accessorCalls, 0);
	assert.equal(parseIntercomControlSendRequest(Object.assign(Object.create({}), request)), null);
});

test("ordinary controls retain legacy extension and JSON.stringify semantics", () => {
	const control = {
		type: "legacy.extension",
		version: 1,
		data: {
			nonFinite: Number.NaN,
			omitted: undefined,
			toJSON() {
				return { serialized: true };
			},
		},
		extension: "tolerated",
	};
	assert.equal(isIntercomControlEnvelope(control), true);
	assert.equal(isIntercomCommonControlEnvelope(control), true);
	assert.deepEqual(parseIntercomControlRegistration({ ...control, registrationExtension: true }), {
		type: "legacy.extension",
		version: 1,
	});
	assert.deepEqual(parseIntercomControlSendRequest({
		requestId: "legacy-delivery",
		to: "worker",
		control,
		requestExtension: true,
	}), {
		requestId: "legacy-delivery",
		to: "worker",
		control,
	});

	const inherited = Object.create({ type: "legacy.inherited", version: 1 });
	assert.equal(isIntercomControlEnvelope(inherited), true);
	assert.equal(isIntercomCommonControlEnvelope(inherited), true);
	assert.equal(isIntercomControlEnvelope({ type: "legacy.bigint", version: 1, data: 1n }), false);
	assert.equal(isIntercomControlEnvelope({
		type: "legacy.oversized",
		version: 1,
		data: { toJSON: () => "x".repeat(17 * 1024) },
	}), false);
});

test("boss.* controls use the strict exact Core envelope parser", () => {
	const control = {
		type: "boss.assignment.created",
		version: BOSS_CONTROL_ENVELOPE_VERSION,
		messageId: "boss-message",
		bossRunId: "boss-run",
		participantId: "manager-participant",
		bindingEpoch: 1,
		idempotencyKey: "boss-idempotency",
		payload: {},
	};
	assert.equal(isIntercomCommonControlEnvelope(control), true);
	assert.equal(isIntercomCommonControlEnvelope({ ...control, extension: true }), false);
	assert.equal(isIntercomCommonControlEnvelope({
		type: "boss.assignment.created",
		version: BOSS_CONTROL_ENVELOPE_VERSION,
		data: {},
	}), false);
});
