import { types as nodeUtilTypes } from "node:util";
import type { BossControlEnvelope } from "@ctliz/agent-intercom-core/boss";
import { parseBossControl } from "./broker/boss-adapter.ts";

export const INTERCOM_CONTROL_REGISTER_EVENT = "intercom:control:register";
export const INTERCOM_CONTROL_SEND_EVENT = "intercom:control:send";
export const INTERCOM_CONTROL_RECEIVED_EVENT = "intercom:control";
export const INTERCOM_CONTROL_DELIVERY_EVENT = "intercom:control:delivery";

export const MAX_CONTROL_TYPE_LENGTH = 128;
export const MAX_CONTROL_DATA_BYTES = 16 * 1024;

export interface IntercomControlEnvelope {
	type: string;
	version: number;
	data?: unknown;
}

export type IntercomCommonControlEnvelope = IntercomControlEnvelope | BossControlEnvelope;

export interface IntercomControlRegistration {
	type: string;
	version: number;
}

export interface IntercomControlSendRequest {
	requestId: string;
	to: string;
	control: IntercomCommonControlEnvelope;
	fallbackText?: string;
	messageId?: string;
}

export interface IntercomControlReceivedEvent {
	from: {
		id: string;
		name?: string;
		cwd: string;
		model: string;
		origin?: "local" | "remote";
		parentSessionId?: string;
		rootSessionId?: string;
	};
	messageId: string;
	receivedAt: number;
	control: IntercomCommonControlEnvelope;
}

export interface IntercomControlDeliveryEvent {
	requestId: string;
	delivered: boolean;
	targetSessionId?: string;
	messageId?: string;
	deliveryId?: string;
	code?: string;
	error?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object"
		&& value !== null
		&& !nodeUtilTypes.isProxy(value)
		&& !Array.isArray(value);
}

function isPlainDataWrapper(value: unknown): value is Record<string, unknown> {
	if (!isObject(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return false;
	}
	return true;
}

function dataValue(record: Record<string, unknown>, key: string): unknown {
	return Object.getOwnPropertyDescriptor(record, key)?.value;
}

export function isIntercomControlEnvelope(value: unknown): value is IntercomControlEnvelope {
	if (!isObject(value)) return false;
	if (
		typeof value.type !== "string"
		|| value.type.length === 0
		|| value.type.length > MAX_CONTROL_TYPE_LENGTH
		|| !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value.type)
	) {
		return false;
	}
	if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) return false;
	if (value.data === undefined) return true;
	try {
		const encoded = JSON.stringify(value.data);
		return encoded !== undefined && Buffer.byteLength(encoded, "utf-8") <= MAX_CONTROL_DATA_BYTES;
	} catch {
		return false;
	}
}

export function isIntercomCommonControlEnvelope(value: unknown): value is IntercomCommonControlEnvelope {
	if (typeof value === "object" && value !== null && nodeUtilTypes.isProxy(value)) return false;
	if (!isObject(value)) return false;
	try {
		if (typeof value.type === "string" && value.type.startsWith("boss.")) {
			return parseBossControl(value) !== null;
		}
		return isIntercomControlEnvelope(value);
	} catch {
		return false;
	}
}

export function parseIntercomControlRegistration(value: unknown): IntercomControlRegistration | null {
	if (!isObject(value)) return null;
	const candidate = { type: value.type, version: value.version };
	return isIntercomControlEnvelope(candidate) ? candidate : null;
}

export function parseIntercomControlSendRequest(value: unknown): IntercomControlSendRequest | null {
	if (!isPlainDataWrapper(value)) return null;
	const requestId = dataValue(value, "requestId");
	const to = dataValue(value, "to");
	const control = dataValue(value, "control");
	const fallbackTextValue = dataValue(value, "fallbackText");
	const messageIdValue = dataValue(value, "messageId");
	if (
		typeof requestId !== "string"
		|| requestId.trim().length === 0
		|| typeof to !== "string"
		|| to.trim().length === 0
		|| !isIntercomCommonControlEnvelope(control)
	) {
		return null;
	}
	if (fallbackTextValue !== undefined && typeof fallbackTextValue !== "string") return null;
	if (messageIdValue !== undefined && (typeof messageIdValue !== "string" || messageIdValue.length === 0)) return null;
	const fallbackText = typeof fallbackTextValue === "string" ? fallbackTextValue : undefined;
	const messageId = typeof messageIdValue === "string" ? messageIdValue : undefined;
	return {
		requestId,
		to,
		control,
		...(fallbackText !== undefined ? { fallbackText } : {}),
		...(messageId !== undefined ? { messageId } : {}),
	};
}

export function intercomControlKey(control: Pick<IntercomControlEnvelope, "type" | "version">): string {
	return `${control.type}@${control.version}`;
}
