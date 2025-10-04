
export interface HassPayload {
	readonly id?: number;
	readonly type: string;
	readonly [key: string]: any;
}

export interface HassMessage extends HassPayload {
	readonly id: number;
}

export interface HassOutgoingCommand extends Omit<HassMessage, 'id'> {
}

export interface HassSubscription<T extends HassEventMessage = HassEventMessage> {
	readonly handler: (msg: T) => Promise<void>;
	unsubscribe(): Promise<void>;
}

export type HassIncomingPayload =
	| HassAuthRequired
	| HassAuthOk
	| HassAuthInvalid
	| HassCommandSuccessResult
	| HassCommandErrorResult
	| HassEventMessage;

/**
 * Message sent by Home Assistant when authentication is required.
 */
export interface HassAuthRequired extends HassMessage {
	readonly type: 'auth_required';
	readonly ha_version: string;
}

/**
 * Message sent by Home Assistant when authentication is successful.
 */
export interface HassAuthOk extends HassMessage {
	readonly type: 'auth_ok';
}

/**
 * Message sent by Home Assistant when authentication fails.
 */
export interface HassAuthInvalid extends HassMessage {
	readonly type: 'auth_invalid';
	readonly message: string;
}

/**
 * Message sent by Home Assistant in response to a command.
 */
export interface HassCommandSuccessResult extends HassMessage {
	readonly id: number;
	readonly type: 'result';
	readonly success: true;
	readonly result?: any;
}

/**
 * Message sent by Home Assistant in response to a command that failed.
 */
export interface HassCommandErrorResult extends HassMessage {
	readonly id: number;
	readonly type: 'result';
	readonly success: false;
	readonly error: {
		readonly code: string;
		readonly message: string;
	};
}

export type HassCommandResult = HassCommandSuccessResult | HassCommandErrorResult;

/**
 * Message sent by Home Assistant when an event occurs.
 */
export interface HassEventMessage extends HassMessage {
	id: number;
	type: 'event';
	event?: any;
}
