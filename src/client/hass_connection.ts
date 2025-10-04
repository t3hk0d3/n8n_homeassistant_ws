import { WebSocket, RawData } from 'ws';
import { EventEmitter } from 'node:events';
import {
	HassCommandResult,
	HassEventMessage,
	HassIncomingPayload,
	HassOutgoingCommand,
	HassSubscription,
} from './types';

/**
 * Represents the possible states of a Home Assistant connection.
 *
 * @enum {string}
 * @property {string} DISCONNECTED - The connection is not established.
 * @property {string} CONNECTING - The connection is in the process of being established.
 * @property {string} CONNECTED - The connection has been established.
 * @property {string} AUTHENTICATING - The connection is authenticating.
 * @property {string} READY - The connection is authenticated and ready for use.
 * @property {string} CLOSED - The connection has been closed.
 */
export const enum HassConnectionState {
	DISCONNECTED = 'disconnected',
	CONNECTING = 'connecting',
	CONNECTED = 'connected',
	AUTHENTICATING = 'authenticating',
	READY = 'ready',
	CLOSED = 'closed',
}

export type HassConnectionCloseDetails =
	| {
			code: number;
			reason: string;
	  }
	| {
			error: Error;
	  };

export type HassConnectionEvents = {
	// state change events
	disconnected: [];
	connecting: [];
	connected: [];
	authenticating: [];
	ready: [];
	closed: [HassConnectionCloseDetails];
	// message events
	message: [HassIncomingPayload];
	error: [Error];
};

type Logger = {
	debug: (...args: any[]) => void;
	info: (...args: any[]) => void;
	warn: (...args: any[]) => void;
	error: (...args: any[]) => void;
};

export interface HassConnectionCredentials {
	host: string; // e.g., "homeassistant.local:8123"
	token: string; // Long-lived access token
	// Optional parameters could be added here in the future
	protocol?: 'ws' | 'wss'; // Default to 'ws'
	path?: string; // Default to '/api/websocket'
}

export interface HassConnectionOptions {
	connectionTimeout: number; // in milliseconds
	closeTimeout: number; // in milliseconds
	logger: Logger;
}

export class HassConnection extends EventEmitter<HassConnectionEvents> {
	private options: HassConnectionOptions = {
		connectionTimeout: 10000,
		closeTimeout: 1000,
		logger: console,
	};

	private ws: WebSocket | null = null;

	private _state: HassConnectionState = HassConnectionState.DISCONNECTED;

	private _messageId = 1;

	private readonly _messageHandlers = new Map<number, (msg: HassIncomingPayload) => void>();

	private readonly logger: Logger;

	constructor(
		private readonly credentials: HassConnectionCredentials,
		options?: Partial<HassConnectionOptions>,
	) {
		super();
		this.options = { ...this.options, ...options };
		this.logger = this.options.logger;

		// Cleanup resources
		this.once('closed', () => {
			this._messageHandlers.clear();
			this.ws?.terminate(); // Ensure WebSocket is fully closed to avoid resource leaks
			this.ws = null; // Dereference WebSocket instance
		});
	}

	get state() {
		return this._state;
	}

	async connect(): Promise<void> {
		if (!this.isDisconnected()) {
			throw new Error(
				'Connection is already established or in progress. Please close the existing connection before connecting again.',
			);
		}

		await this.openConnection();
	}

	async close(): Promise<void> {
		if (this.isClosed() || this.isDisconnected()) {
			this.logger.debug('Connection is already closed or disconnected.');
			return;
		}

		return new Promise((resolve, reject) => {
			if (this.ws) {
				// If there's an active WebSocket instance, close it gracefully
				// it's important to wait for the close event before nullifying the ws reference

				// Set up a timeout to force close if it takes too long
				const _cleanup = setTimeout(() => {
					if (this.ws) {
						if (this.ws.readyState !== WebSocket.CLOSED) {
							this.logger.warn(
								`Forcing WebSocket stuck in state=${this.ws.readyState} termination after timeout ${this.options.closeTimeout}ms.`,
							);
							this.ws.terminate();
						}
						this.setState(HassConnectionState.CLOSED, { code: 1000, reason: 'Closed by client' });
						resolve();
					}
				}, this.options.closeTimeout);

				// Listen for the close event to confirm closure
				this.ws.once('close', () => {
					clearTimeout(_cleanup);
					resolve();
				});

				// Initiate the close
				this.ws.close(1000, 'Closed by client');
			} else {
				// If there's no WebSocket instance, just set state to CLOSED
				this.setState(HassConnectionState.CLOSED, { code: 1000, reason: 'Closed by client' });

				resolve();
			}
		});
	}

	async send(command: HassOutgoingCommand, timeout: number = 0): Promise<HassCommandResult> {
		if (!this.ws || !this.isReady()) {
			throw new Error('Connection is not ready to send commands.');
		}

		const id = this._messageId++;
		const msg = JSON.stringify({ ...command, id });

		return new Promise<HassCommandResult>((resolve, reject) => {
			this._messageHandlers.set(id, (response) => {
				this._messageHandlers.delete(id);
				if (response.type === 'result') {
					resolve(response as HassCommandResult);
				} else {
					reject(new Error(`Unexpected response type: ${response.type}`));
				}
			});

			this.ws!.send(msg, (err) => {
				if (err) {
					this.logger.error(`Failed to send message: ${err.message}`);
					this._messageHandlers.delete(id);
					reject(err);
				} else {
					this.logger.debug(`Sent message: ${msg}`);
					if (timeout > 0) {
						setTimeout(() => {
							if (this._messageHandlers.has(id)) {
								this._messageHandlers.delete(id);
								reject(new Error(`Command timed out after ${timeout} ms.`));
							}
						}, timeout);
					}
				}
			});
		});
	}

	async subscribe<T extends HassEventMessage = HassEventMessage>(
		command: HassOutgoingCommand,
		handler: (msg: T) => Promise<void>,
	): Promise<HassSubscription<T>> {
		if (!this.ws || !this.isReady()) {
			throw new Error('Connection is not ready to subscribe.');
		}

		const id = this._messageId++;
		const subscription: HassSubscription<T> = {
			handler,
			unsubscribe: async () => {
				if (!this.ws || !this.isReady()) {
					throw new Error('Connection is not ready to unsubscribe.');
				}
				await this.send({ type: 'unsubscribe_events', subscription_id: id });
			},
		};

		return new Promise<HassSubscription<T>>((resolve, reject) => {
			this._messageHandlers.set(id, (response) => {
				if (response.type === 'event') {
					process.nextTick(() => subscription.handler(response as T));
				} else if (response.type === 'result' && response.success) {
					this.logger.info(`Subscription successful (id=${id})`);
					resolve(subscription);
					return;
				} else if (response.type === 'result' && !response.success) {
					this.logger.warn(`Subscription failed - ${response.error}`);
					this._messageHandlers.delete(id);
					reject(new Error(`Subscription failed`, { cause: response.error }));
					return;
				} else {
					this.logger.warn(`Unexpected response to subscription: ${response.type}`);
				}
			});

			this.ws!.send(JSON.stringify({ ...command, id }), (err) => {
				if (err) {
					this.logger.warn(`Failed to send subscription message: ${err.message}`);
					this._messageHandlers.delete(id);
					reject(err);
				}
			});
		});
	}

	isDisconnected(): boolean {
		return this.inState(HassConnectionState.DISCONNECTED);
	}

	isClosed(): boolean {
		return this.inState(HassConnectionState.CLOSED);
	}

	isReady(): boolean {
		return this.inState(HassConnectionState.READY);
	}

	isPending(): boolean {
		return this.inState(
			HassConnectionState.CONNECTING,
			HassConnectionState.CONNECTED,
			HassConnectionState.AUTHENTICATING,
		);
	}

	private inState(...states: HassConnectionState[]): boolean {
		return states.includes(this._state);
	}

	private async openConnection(): Promise<void> {
		// Clean up existing connection if any
		this.ws?.terminate();
		this.ws = null;

		this.setState(HassConnectionState.CONNECTING);

		return new Promise((resolve, reject) => {
			const ws = new WebSocket(
				`${this.credentials.protocol || 'ws'}://${this.credentials.host}${this.credentials.path || '/api/websocket'}`,
			);

			const connectionTimeout = this.options.connectionTimeout
				? setTimeout(() => {
						const error = new Error(
							`Connection timed out after ${this.options.connectionTimeout} ms.`,
						);

						ws.terminate();
						reject(error);
						this.setState(HassConnectionState.CLOSED, { error });
					}, this.options.connectionTimeout)
				: null;

			ws.once('error', (error) => {
				this.logger.debug(`WebSocket error during connection: ${error.message}`);
				connectionTimeout && clearTimeout(connectionTimeout);
				reject(error);
				this.setState(HassConnectionState.CLOSED, { error });
			});

			ws.once('close', (code, reason) => {
				this.logger.debug('WebSocket closed during connection attempt.');
				const error = new Error(
					`Connection closed before it could be established (code=${code}, reason=${reason})`,
				);
				connectionTimeout && clearTimeout(connectionTimeout);
				this.setState(HassConnectionState.CLOSED, { code, reason: reason.toString() });
				reject(error);
			});

			ws.once('open', () => {
				this.logger.debug('WebSocket connection opened.');
				// save websocket instance only after successful connection
				this.ws = ws;
				// Remove these listeners, we'll add our own in the next step
				ws.removeAllListeners('error');
				ws.removeAllListeners('close');
				// Add listeners for normal operation
				ws.on('error', (error) => this.setState(HassConnectionState.CLOSED, { error }));
				ws.on('close', (code, reason) =>
					this.setState(HassConnectionState.CLOSED, { code, reason: reason.toString() }),
				);
				this.setState(HassConnectionState.CONNECTED);
			});

			// Handle authentication messages
			ws.on('message', (message) => {
				const parsedMessage: HassIncomingPayload = this.parseWebsocketMessage(message);

				switch (parsedMessage.type) {
					case 'auth_required':
						this.logger.debug(
							`Authentication required, sending token. [HA Version: ${parsedMessage.ha_version}]`,
						);
						this.setState(HassConnectionState.AUTHENTICATING);
						ws.send(JSON.stringify({ type: 'auth', access_token: this.credentials.token }));
						break;
					case 'auth_ok':
						this.logger.info('Authentication successful.');
						connectionTimeout && clearTimeout(connectionTimeout);
						this.setState(HassConnectionState.READY);
						ws.removeAllListeners('message');
						ws.on('message', (data) => this.onMessage(data));
						resolve();
						break;
					case 'auth_invalid':
						this.logger.error(`Authentication failed: ${parsedMessage.message}`);
						connectionTimeout && clearTimeout(connectionTimeout);

						const error = new Error(`Authentication failed: ${parsedMessage.message}`);

						this.setState(HassConnectionState.CLOSED, { error });
						ws.close();
						reject(error);
						break;
				}
			});
		});
	}

	private parseWebsocketMessage(message: RawData): HassIncomingPayload {
		try {
			return JSON.parse(message.toString());
		} catch (e) {
			this.emit('error', new Error('Failed to parse websocket message.'));
			throw e;
		}
	}

	private onMessage(data: RawData) {
		const incomingMessage = this.parseWebsocketMessage(data);
		this.emit('message', incomingMessage);

		if (!incomingMessage.id) {
			this.logger.debug(`Received message without ID`);
			return;
		}

		const handler = this._messageHandlers.get(incomingMessage.id);
		if (handler) {
			handler(incomingMessage);
			this._messageHandlers.delete(incomingMessage.id);
		} else {
			this.logger.warn(`Received unexpected message ID=${incomingMessage.id}`);
		}
	}

	private setState<T extends HassConnectionState>(
		newState: T,
		...args: T extends keyof HassConnectionEvents ? HassConnectionEvents[T] : never
	): void {
		if (this._state === newState) {
			this.logger.debug(`State is already ${newState}, not changing.`);
			return;
		}

		this.logger.info(`State changed from ${this._state} to ${newState}`);

		this._state = newState;
		this.emit(newState, ...args); // Emit event with correct arguments
	}
}
