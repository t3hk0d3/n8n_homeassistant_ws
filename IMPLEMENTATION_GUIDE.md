# Implementation Guide for Corner Case Fixes

This guide provides step-by-step instructions for implementing fixes for the identified corner cases in the HomeAssistant WebSocket implementation.

---

## Before You Start

### Prerequisites
1. Read [CORNER_CASES_ANALYSIS.md](./CORNER_CASES_ANALYSIS.md) for detailed issue descriptions
2. Review [CORNER_CASES_SUMMARY.md](./CORNER_CASES_SUMMARY.md) for prioritized list
3. Study [CORNER_CASES_DIAGRAMS.md](./CORNER_CASES_DIAGRAMS.md) for visual understanding

### Setup Development Environment
```bash
npm install
npm run lint
npm run build
```

### Recommended Implementation Order
Fix issues in priority order (P1 → P2 → P3 → P4) to maximize impact and minimize risk.

---

## Phase 1: Critical Fixes (P1)

### Fix #1: Add Try-Catch Around JSON Parsing

**Location**: `HomeAssistant.ts` - `get_authenticated_ws()` method

**Current Code**:
```typescript
ws.on('message', (event: MessageEvent) => {
    const data = JSON.parse(event.toString());
    // ... process message
});
```

**Fixed Code**:
```typescript
ws.on('message', (event: MessageEvent) => {
    let data;
    try {
        data = JSON.parse(event.toString());
    } catch (error) {
        this.logger.error('Failed to parse WebSocket message:', error);
        this.logger.debug('Raw message:', event.toString());
        return; // Skip this message, don't crash
    }
    
    // ... process message
});
```

**Test**:
```typescript
// Send malformed JSON to verify no crash
ws.send('{ invalid json }');
ws.send('not json at all');
```

---

### Fix #2: Clear Callbacks on Connection Close

**Location**: `HomeAssistant.ts` - `close()` method and connection error handlers

**Add Method**:
```typescript
private clearAllCallbacks(): void {
    this.callbacks.forEach((callback, id) => {
        // Reject pending promises with connection closed error
        try {
            callback(MessageType.ERROR, {
                error: { code: 'connection_closed', message: 'Connection closed' }
            });
        } catch (e) {
            this.logger.debug(`Error cleaning up callback ${id}:`, e);
        }
    });
    this.callbacks.clear();
}
```

**Update close() method**:
```typescript
close(): Promise<void> {
    this.stopReconnecting();
    this.stopPingPong();
    this.clearAllCallbacks(); // Add this line
    return this.ws.then(ws => {
        this.ws.close();
        ws.close();
    });
}
```

**Update get_authenticated_ws() close handler**:
```typescript
ws.on('close', (code: number, reason: Buffer) => {
    this.logger.info(`WebSocket closed with code ${code}, reason: ${reason.toString()}`);
    this.stopPingPong();
    this.clearAllCallbacks(); // Add this line
    this.emit('close', code, reason.toString());
    
    if (this.shouldReconnect && code !== 1000 && !this.isReconnecting) {
        this.attemptReconnect();
    }
});
```

**Test**:
```typescript
// Send multiple requests, then close connection
const promises = [];
for (let i = 0; i < 10; i++) {
    promises.push(assistant.get_states());
}
assistant.close();
// All promises should be rejected with connection_closed error
```

---

### Fix #3: Proper WebSocket Cleanup on Reconnection

**Location**: `HomeAssistant.ts` - `attemptReconnect()` method

**Current Code**:
```typescript
this.reconnectTimeoutId = setTimeout(() => {
    try {
        this.stopPingPong();
        this.ws.close();  // Only closes wrapper
        this.cmd.reset();
        this.ws = this.get_authenticated_ws();
        // ...
    }
}, delay);
```

**Fixed Code**:
```typescript
this.reconnectTimeoutId = setTimeout(() => {
    try {
        this.stopPingPong();
        this.clearAllCallbacks(); // Add: Clear pending callbacks
        
        // Properly terminate old WebSocket
        this.ws.then(ws => {
            ws.removeAllListeners(); // Add: Remove event listeners
            ws.terminate();          // Add: Force close socket
        }).catch(err => {
            this.logger.debug('Error terminating old WebSocket:', err);
        });
        
        this.ws.close(); // Close wrapper
        this.cmd.reset();
        this.ws = this.get_authenticated_ws();
        this.logger.info(`Reconnection attempt ${this.reconnectAttempts} initiated`);
    } catch (error) {
        this.logger.error('Error during reconnection attempt:', error);
        this.isReconnecting = false;
        this.attemptReconnect();
    }
}, delay);
```

**Test**:
```typescript
// Trigger multiple rapid reconnections
for (let i = 0; i < 5; i++) {
    // Close and wait for reconnect
    ws.close();
    await new Promise(resolve => setTimeout(resolve, 100));
}
// Check that only one WebSocket instance exists
// Check that memory doesn't grow
```

---

### Fix #4: Always Clear Old Timeout Before Setting New

**Location**: `HomeAssistant.ts` - `sendPing()` method

**Current Code**:
```typescript
private sendPing(): void {
    const pingId = this.cmd.get();
    // ...
    this.pongTimeoutId = setTimeout(() => {
        this.handlePongTimeout();
    }, this.pongTimeout);
}
```

**Fixed Code**:
```typescript
private sendPing(): void {
    const pingId = this.cmd.get();
    const pingMessage = {
        type: 'ping',
        id: pingId
    };

    this.logger.debug(`Sending ping ${pingId}`);

    this.ws.then(ws => {
        ws.send(JSON.stringify(pingMessage));
    }).catch(error => {
        this.logger.error('Failed to send ping:', error);
    });

    // Clear old timeout before setting new one
    if (this.pongTimeoutId) {
        clearTimeout(this.pongTimeoutId);
        this.pongTimeoutId = null;
    }

    // Set timeout to wait for pong
    this.pongTimeoutId = setTimeout(() => {
        this.logger.warn(`Pong timeout for ping ${pingId}`);
        this.handlePongTimeout();
    }, this.pongTimeout);
}
```

**Test**:
```typescript
// Call sendPing multiple times rapidly
for (let i = 0; i < 10; i++) {
    assistant.sendPing();
    await new Promise(resolve => setTimeout(resolve, 100));
}
// Verify only one timeout is active
```

---

### Fix #5: Clear Reconnection Timeout in Error Path

**Location**: `HomeAssistant.ts` - `attemptReconnect()` method

**Current Code**:
```typescript
} catch (error) {
    this.logger.error('Error during reconnection attempt:', error);
    this.isReconnecting = false;
    this.attemptReconnect(); // Recursive call creates new timeout
}
```

**Fixed Code**:
```typescript
} catch (error) {
    this.logger.error('Error during reconnection attempt:', error);
    this.isReconnecting = false;
    
    // Clear the failed timeout
    if (this.reconnectTimeoutId) {
        clearTimeout(this.reconnectTimeoutId);
        this.reconnectTimeoutId = null;
    }
    
    this.attemptReconnect(); // Now safe to retry
}
```

---

## Phase 2: High Priority Fixes (P2)

### Fix #6: Implement Connection State Machine

**Create new file**: `ConnectionState.ts`

```typescript
export enum ConnectionState {
    DISCONNECTED = 'DISCONNECTED',
    CONNECTING = 'CONNECTING',
    AUTHENTICATING = 'AUTHENTICATING',
    CONNECTED = 'CONNECTED',
    CLOSING = 'CLOSING',
    CLOSED = 'CLOSED',
    ERROR = 'ERROR'
}

export class ConnectionStateMachine {
    private state: ConnectionState = ConnectionState.DISCONNECTED;
    private transitionCallbacks: Map<ConnectionState, ((from: ConnectionState) => void)[]> = new Map();

    constructor(private logger: any) {}

    getState(): ConnectionState {
        return this.state;
    }

    canTransitionTo(newState: ConnectionState): boolean {
        const validTransitions: Record<ConnectionState, ConnectionState[]> = {
            [ConnectionState.DISCONNECTED]: [ConnectionState.CONNECTING, ConnectionState.CLOSED],
            [ConnectionState.CONNECTING]: [ConnectionState.AUTHENTICATING, ConnectionState.ERROR, ConnectionState.CLOSED],
            [ConnectionState.AUTHENTICATING]: [ConnectionState.CONNECTED, ConnectionState.ERROR, ConnectionState.CLOSED],
            [ConnectionState.CONNECTED]: [ConnectionState.CLOSING, ConnectionState.ERROR, ConnectionState.DISCONNECTED],
            [ConnectionState.CLOSING]: [ConnectionState.CLOSED, ConnectionState.DISCONNECTED],
            [ConnectionState.CLOSED]: [ConnectionState.CONNECTING],
            [ConnectionState.ERROR]: [ConnectionState.CONNECTING, ConnectionState.CLOSED, ConnectionState.DISCONNECTED]
        };

        return validTransitions[this.state]?.includes(newState) ?? false;
    }

    transitionTo(newState: ConnectionState): boolean {
        if (!this.canTransitionTo(newState)) {
            this.logger.warn(`Invalid state transition from ${this.state} to ${newState}`);
            return false;
        }

        const oldState = this.state;
        this.state = newState;
        this.logger.debug(`State transition: ${oldState} → ${newState}`);

        // Notify callbacks
        const callbacks = this.transitionCallbacks.get(newState) || [];
        callbacks.forEach(cb => {
            try {
                cb(oldState);
            } catch (e) {
                this.logger.error('Error in state transition callback:', e);
            }
        });

        return true;
    }

    onTransitionTo(state: ConnectionState, callback: (from: ConnectionState) => void): void {
        if (!this.transitionCallbacks.has(state)) {
            this.transitionCallbacks.set(state, []);
        }
        this.transitionCallbacks.get(state)!.push(callback);
    }

    isConnected(): boolean {
        return this.state === ConnectionState.CONNECTED;
    }

    isDisconnected(): boolean {
        return this.state === ConnectionState.DISCONNECTED || 
               this.state === ConnectionState.CLOSED;
    }
}
```

**Update HomeAssistant.ts**:

```typescript
import { ConnectionState, ConnectionStateMachine } from './ConnectionState';

export class HomeAssistant extends EventEmitter {
    // Replace boolean flags with state machine
    private connectionState: ConnectionStateMachine;
    
    constructor(private host: CredentialInformation, private apiKey: CredentialInformation, private logger: Logger) {
        super();
        this.connectionState = new ConnectionStateMachine(logger);
        this.ws = this.get_authenticated_ws();
    }

    // Add guard methods
    private ensureConnected(): void {
        if (!this.connectionState.isConnected()) {
            throw new Error(`Operation not allowed in state: ${this.connectionState.getState()}`);
        }
    }

    // Update methods to use state machine
    private get_authenticated_ws(): SocketConnection<WebSocket> {
        this.connectionState.transitionTo(ConnectionState.CONNECTING);
        
        const url = 'ws://' + this.host + '/api/websocket';
        const ws = new WebSocket(url, { followRedirects: true });
        
        const socket = new SocketConnection(ws);
        
        ws.on('message', (event: MessageEvent) => {
            // ... JSON parsing with try-catch
            
            if (data['type'] == 'auth_required') {
                this.connectionState.transitionTo(ConnectionState.AUTHENTICATING);
                ws.send(JSON.stringify({
                    type: 'auth',
                    access_token: this.apiKey,
                }));
            } else if (data['type'] == 'auth_ok') {
                this.reconnectAttempts = 0;
                this.isReconnecting = false;
                
                this.connectionState.transitionTo(ConnectionState.CONNECTED);
                socket.ready();
                this.emit('connected');
                this.startPingPong();
            } else if (data['type'] == 'auth_invalid') {
                this.connectionState.transitionTo(ConnectionState.ERROR);
                this.logger.error('WebSocket error', data);
                socket.error(data.message);
            }
            // ... rest of message handling
        });

        ws.on('close', (code: number, reason: Buffer) => {
            this.connectionState.transitionTo(ConnectionState.DISCONNECTED);
            // ... rest of close handling
        });

        return socket;
    }
}
```

**Test**:
```typescript
// Test invalid state transitions are rejected
assert.throws(() => {
    stateMachine.transitionTo(ConnectionState.CONNECTED); // From DISCONNECTED
});

// Test valid transitions work
assert(stateMachine.transitionTo(ConnectionState.CONNECTING));
assert(stateMachine.transitionTo(ConnectionState.AUTHENTICATING));
assert(stateMachine.transitionTo(ConnectionState.CONNECTED));
```

---

### Fix #7: Reset Command Counter AFTER Clearing Callbacks

**Location**: `HomeAssistant.ts` - `attemptReconnect()` method

**Current Code**:
```typescript
this.ws.close();
this.cmd.reset();
this.ws = this.get_authenticated_ws();
```

**Fixed Code**:
```typescript
this.ws.close();
this.clearAllCallbacks(); // Clear old callbacks first
this.cmd.reset();          // Then reset counter
this.ws = this.get_authenticated_ws();
```

---

### Fix #8: Track and Clean Up Subscriptions

**Add to HomeAssistant class**:

```typescript
export class HomeAssistant extends EventEmitter {
    // Add subscription tracking
    private activeSubscriptions: Set<number> = new Set();
    
    private clearAllSubscriptions(): void {
        this.activeSubscriptions.forEach(id => {
            const callback = this.callbacks.get(id);
            if (callback) {
                try {
                    // Send unsubscribed notification
                    callback(MessageType.ERROR, {
                        error: { code: 'unsubscribed', message: 'Connection lost, subscription cancelled' }
                    });
                } catch (e) {
                    this.logger.debug(`Error clearing subscription ${id}:`, e);
                }
                this.callbacks.delete(id);
            }
        });
        this.activeSubscriptions.clear();
    }
    
    subscribe_generic(type: string, params: any): Promise<EventEmitter> {
        this.ensureConnected(); // Use state guard
        
        const emitter = new EventEmitter();
        const id = this.cmd.get();
        
        // Track this subscription
        this.activeSubscriptions.add(id);
        
        this.callbacks.set(id, (type: MessageType, data: any) => {
            if (type == MessageType.RESULT) {
                if (!data['success']) {
                    emitter.emit('error', data['error']);
                    this.callbacks.delete(id);
                    this.activeSubscriptions.delete(id); // Clean up tracking
                } else {
                    emitter.emit(MessageType.RESULT, data['result']);
                }
            } else if (type == MessageType.EVENT) {
                emitter.emit(MessageType.EVENT, data['event']);
            } else if (type == MessageType.ERROR) {
                emitter.emit(MessageType.ERROR, data);
                this.callbacks.delete(id);
                this.activeSubscriptions.delete(id); // Clean up tracking
            }
        });

        return this.send(id, type, params).then(() => {
            // Provide unsubscribe method
            emitter.once('unsubscribe', () => {
                this.callbacks.delete(id);
                this.activeSubscriptions.delete(id);
                // Optionally send unsubscribe message to server
            });
            return emitter;
        });
    }
}
```

**Update close() to clean subscriptions**:
```typescript
close(): Promise<void> {
    this.stopReconnecting();
    this.stopPingPong();
    this.clearAllSubscriptions(); // Add this
    this.clearAllCallbacks();
    return this.ws.then(ws => {
        this.ws.close();
        ws.close();
    });
}
```

---

## Phase 3: Medium Priority Fixes (P3)

### Fix #9: Add Authentication Timeout

**Add to HomeAssistant class**:

```typescript
private authenticationTimeout: NodeJS.Timeout | null = null;
private readonly AUTH_TIMEOUT = 10000; // 10 seconds

private get_authenticated_ws(): SocketConnection<WebSocket> {
    // ... existing code ...
    
    // Set authentication timeout
    this.authenticationTimeout = setTimeout(() => {
        if (this.connectionState.getState() === ConnectionState.AUTHENTICATING) {
            this.logger.error('Authentication timeout');
            ws.terminate();
            socket.error('Authentication timeout');
            this.connectionState.transitionTo(ConnectionState.ERROR);
        }
    }, this.AUTH_TIMEOUT);
    
    ws.on('message', (event: MessageEvent) => {
        // ... JSON parsing ...
        
        if (data['type'] == 'auth_ok') {
            // Clear authentication timeout
            if (this.authenticationTimeout) {
                clearTimeout(this.authenticationTimeout);
                this.authenticationTimeout = null;
            }
            
            // ... rest of auth_ok handling ...
        } else if (data['type'] == 'auth_invalid') {
            // Clear authentication timeout
            if (this.authenticationTimeout) {
                clearTimeout(this.authenticationTimeout);
                this.authenticationTimeout = null;
            }
            
            // ... rest of auth_invalid handling ...
        }
    });
    
    return socket;
}
```

---

### Fix #10: Prevent Reconnection on Non-Recoverable Errors

**Update close handler**:

```typescript
ws.on('close', (code: number, reason: Buffer) => {
    this.logger.info(`WebSocket closed with code ${code}, reason: ${reason.toString()}`);
    this.connectionState.transitionTo(ConnectionState.DISCONNECTED);
    this.stopPingPong();
    this.clearAllCallbacks();
    this.emit('close', code, reason.toString());

    // Classify error codes
    const NON_RECOVERABLE_CODES = [
        1000, // Normal closure
        1008, // Policy violation (auth failure)
        1011, // Server error
    ];

    // Only attempt to reconnect for recoverable errors
    if (this.shouldReconnect && 
        !NON_RECOVERABLE_CODES.includes(code) && 
        !this.isReconnecting) {
        this.attemptReconnect();
    } else if (NON_RECOVERABLE_CODES.includes(code)) {
        this.logger.info(`Connection closed with non-recoverable code ${code}, not reconnecting`);
        this.emit('permanent_close', code, reason.toString());
    }
});
```

---

## Phase 4: Low Priority Fixes (P4)

### Fix #11: Set EventEmitter Max Listeners

**Add to constructor**:

```typescript
constructor(private host: CredentialInformation, private apiKey: CredentialInformation, private logger: Logger) {
    super();
    this.setMaxListeners(50); // Allow up to 50 listeners
    this.connectionState = new ConnectionStateMachine(logger);
    this.ws = this.get_authenticated_ws();
}
```

---

## Testing Strategy

### Unit Tests

Create `tests/HomeAssistant.test.ts`:

```typescript
import { HomeAssistant } from '../HomeAssistant';
import { Logger } from 'n8n-workflow';

describe('HomeAssistant Connection Management', () => {
    let assistant: HomeAssistant;
    let mockLogger: Logger;

    beforeEach(() => {
        mockLogger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        } as any;
    });

    test('should reject pending promises on connection close', async () => {
        assistant = new HomeAssistant('localhost:8123', 'token', mockLogger);
        
        const promise = assistant.get_states();
        assistant.close();
        
        await expect(promise).rejects.toThrow('connection_closed');
    });

    test('should clean up timeouts on close', async () => {
        assistant = new HomeAssistant('localhost:8123', 'token', mockLogger);
        
        // Start ping-pong
        await assistant.ws.then(() => {});
        
        // Close connection
        await assistant.close();
        
        // Verify no timeouts are active
        // (Use jest.advanceTimersByTime to check)
    });

    test('should not crash on malformed JSON', async () => {
        assistant = new HomeAssistant('localhost:8123', 'token', mockLogger);
        
        // Send malformed JSON
        const ws = await assistant.ws.get();
        expect(() => {
            ws.emit('message', Buffer.from('{ invalid json }'));
        }).not.toThrow();
    });
});
```

### Integration Tests

Create `tests/integration/reconnection.test.ts`:

```typescript
describe('Reconnection Logic', () => {
    test('should clean up resources on reconnection', async () => {
        // Track memory usage
        const initialMemory = process.memoryUsage().heapUsed;
        
        // Trigger multiple reconnections
        for (let i = 0; i < 10; i++) {
            // Simulate connection loss
            ws.close();
            await waitForReconnect();
        }
        
        // Force garbage collection if available
        if (global.gc) global.gc();
        
        const finalMemory = process.memoryUsage().heapUsed;
        const memoryGrowth = finalMemory - initialMemory;
        
        // Memory should not grow significantly
        expect(memoryGrowth).toBeLessThan(1024 * 1024); // Less than 1MB
    });
});
```

---

## Validation Checklist

After implementing fixes, verify:

- [ ] All linting passes: `npm run lint`
- [ ] All tests pass: `npm test`
- [ ] Build succeeds: `npm run build`
- [ ] Manual testing of key scenarios:
  - [ ] Rapid connect/disconnect cycles
  - [ ] Connection loss during pending requests
  - [ ] Malformed message handling
  - [ ] Long-running connection (24h+)
  - [ ] Multiple subscriptions cleanup
  - [ ] Authentication failure handling
  - [ ] Network instability simulation

---

## Monitoring After Deployment

Add these metrics to your monitoring:

```typescript
export interface ConnectionMetrics {
    activeCallbacks: number;
    activeSubscriptions: number;
    activeTimeouts: number;
    reconnectionAttempts: number;
    memoryUsage: number;
    eventListenerCount: number;
}

public getMetrics(): ConnectionMetrics {
    return {
        activeCallbacks: this.callbacks.size,
        activeSubscriptions: this.activeSubscriptions.size,
        activeTimeouts: this.getActiveTimeoutCount(),
        reconnectionAttempts: this.reconnectAttempts,
        memoryUsage: process.memoryUsage().heapUsed,
        eventListenerCount: this.listenerCount('message') + 
                           this.listenerCount('error') + 
                           this.listenerCount('close')
    };
}
```

---

## Rollback Plan

If issues arise after deployment:

1. **Immediate**: Revert to previous version
2. **Monitor**: Check error logs for new issues
3. **Investigate**: Use metrics to identify problem area
4. **Fix**: Apply targeted fix for specific issue
5. **Test**: Validate fix in staging
6. **Redeploy**: Deploy fixed version

---

## Additional Resources

- [Full Analysis](./CORNER_CASES_ANALYSIS.md)
- [Quick Reference](./CORNER_CASES_SUMMARY.md)
- [Visual Diagrams](./CORNER_CASES_DIAGRAMS.md)
- [WebSocket API Spec](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
- [Node.js EventEmitter](https://nodejs.org/api/events.html)

---

**Document Version**: 1.0  
**Last Updated**: 2024  
**Status**: Implementation Guide
