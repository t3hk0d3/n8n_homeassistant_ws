# Corner Case Analysis for HomeAssistant WebSocket Connection

## Executive Summary

This document provides a comprehensive analysis of the `HomeAssistant` and `SocketConnection` classes, identifying critical corner cases, race conditions, resource leaks, and potential issues that could lead to unexpected behavior, memory leaks, and application crashes in production environments.

---

## Critical Corner Cases

### 1. Race Condition in Reconnection Management

**Location**: `HomeAssistant.ts` - `attemptReconnect()` method

**Issue**: Multiple simultaneous reconnection attempts can occur when network is unstable.

```typescript
private attemptReconnect(): void {
    if (this.isReconnecting || !this.shouldReconnect) {
        return;  // Guard check
    }
    
    this.isReconnecting = true;
    this.reconnectAttempts++;
    
    // RACE: Multiple close events could trigger this before flag is set
    // RACE: setTimeout is async, state could change before execution
}
```

**Problem Details**:
- If multiple `close` events fire rapidly (network flapping), the guard check may not prevent multiple reconnection timers from being scheduled
- The `isReconnecting` flag is set synchronously, but the actual reconnection happens in a setTimeout callback
- Between checking `this.isReconnecting` and setting it to `true`, another thread could enter

**Impact**: Memory leaks from multiple reconnection timers, duplicate WebSocket connections

---

### 2. Resource Leak in Timeout and Interval Handling

**Location**: `HomeAssistant.ts` - Multiple methods

**Issue**: Timeouts and intervals are not always cleared in error paths.

```typescript
// Reconnection timeout may leak
this.reconnectTimeoutId = setTimeout(() => {
    try {
        // If this throws, timeout is not cleared elsewhere
        this.ws = this.get_authenticated_ws();
    } catch (error) {
        this.isReconnecting = false;
        // Timeout ID is not cleared here
        this.attemptReconnect(); // Creates new timeout!
    }
}, delay);
```

**Problem Details**:
- `reconnectTimeoutId` is only cleared in `stopReconnecting()`, not in error paths
- `pingIntervalId` and `pongTimeoutId` may not be cleared if connection closes unexpectedly
- Recursive `attemptReconnect()` call in catch block creates additional timeouts without clearing the failed one

**Impact**: Memory leaks, runaway timers, unexpected reconnection attempts after connection is closed

---

### 3. Callback Map Memory Leak

**Location**: `HomeAssistant.ts` - `callbacks` Map

**Issue**: Message handlers are not cleaned up when connection closes.

```typescript
private callbacks: Map<number, (type: MessageType, data: any) => void> = new Map();

private send_with_single_response<T>(...): Promise<T> {
    const promise = new Promise<T>((resolve, reject) => {
        this.callbacks.set(id, (type: MessageType, data: any) => {
            try {
                this.callbacks.delete(id); // Only deleted on response
                // ...
            }
        });
    });
    return this.send(id, type, params).then(() => promise);
}
```

**Problem Details**:
- If connection closes while waiting for responses, callbacks remain in Map indefinitely
- Each pending request adds an entry that never gets cleaned up on connection loss
- Promises are never resolved or rejected, leading to dangling promise chains

**Impact**: Memory leak proportional to number of pending requests when connection fails

---

### 4. Double WebSocket Creation on Reconnect

**Location**: `HomeAssistant.ts` - `attemptReconnect()` method

**Issue**: Old WebSocket connection is not properly terminated before creating new one.

```typescript
private attemptReconnect(): void {
    // ...
    this.reconnectTimeoutId = setTimeout(() => {
        this.stopPingPong();
        this.ws.close();  // Only closes SocketConnection wrapper
        this.cmd.reset();
        this.ws = this.get_authenticated_ws();  // Creates new WebSocket
    }, delay);
}
```

**Problem Details**:
- `this.ws.close()` only sets `isClosed` flag in `SocketConnection`, doesn't terminate the underlying WebSocket
- Old WebSocket may still be open and consuming resources
- Event listeners on old WebSocket are never removed
- Multiple WebSockets could be simultaneously connected

**Impact**: Resource leak, unexpected message routing, connection state confusion

---

### 5. SocketConnection State Race Conditions

**Location**: `SocketConnection.ts` - State management

**Issue**: State checks and updates are not atomic.

```typescript
get(): Promise<T> {
    if (this.isReady) {
        return Promise.resolve(this.obj);
    } else if (this.isClosed) {
        return Promise.reject(new Error('SocketConnection is closed'));
    } else if (this.isError) {
        return Promise.reject(new Error(this.isError));
    } else {
        return new Promise((resolve, reject) => {
            this.observers.push(resolve);
            this.rejectors.push(reject);
        });
    }
}
```

**Problem Details**:
- State can change between check and action (TOCTOU - Time Of Check Time Of Use)
- `ready()` or `error()` could be called between the state check and adding to observers
- No locking mechanism to ensure atomic state transitions
- Multiple calls to `ready()` or `error()` could cause issues

**Impact**: Race conditions, missed notifications, double resolution of promises

---

### 6. Ping-Pong Timeout Accumulation

**Location**: `HomeAssistant.ts` - `sendPing()` and related methods

**Issue**: Pong timeout is not cleared when new ping is sent.

```typescript
private sendPing(): void {
    // ...
    this.pongTimeoutId = setTimeout(() => {
        this.logger.warn(`Pong timeout for ping ${pingId}`);
        this.handlePongTimeout();
    }, this.pongTimeout);
    // If sendPing is called again before timeout, old timeout is lost
}

private handlePongReceived(data: any): void {
    // ...
    if (this.pongTimeoutId) {
        clearTimeout(this.pongTimeoutId);
        this.pongTimeoutId = null;
    }
    // Only clears the LATEST timeout, not accumulated ones
}
```

**Problem Details**:
- Each `sendPing()` overwrites `this.pongTimeoutId` without clearing the old one
- If ping interval is shorter than pong timeout, multiple timeouts accumulate
- Old timeouts continue to run even after pong is received

**Impact**: Memory leak, false positive timeout triggers, unnecessary reconnections

---

### 7. Command Counter Reset Race Condition

**Location**: `HomeAssistant.ts` - `cmd` CommandCounter

**Issue**: Command counter reset during reconnection can cause ID collisions.

```typescript
private attemptReconnect(): void {
    // ...
    this.cmd.reset();  // Resets to 1
    this.ws = this.get_authenticated_ws();
    // If old callbacks still exist in Map, IDs will collide
}
```

**Problem Details**:
- Old callbacks in Map may have IDs 1, 2, 3, etc.
- After reset, new commands start at ID 1 again
- Responses to old commands could be routed to new command handlers
- New responses could be routed to old (now invalid) handlers

**Impact**: Data corruption, wrong command responses, unexpected behavior

---

## Additional Edge Cases

### 8. WebSocket Event Listener Accumulation

**Location**: `HomeAssistant.ts` - `get_authenticated_ws()` method

**Issue**: Event listeners are added but never removed.

```typescript
ws.on('message', (event: MessageEvent) => { /* ... */ });
ws.on('error', (error: any) => { /* ... */ });
ws.on('close', (code: number, reason: Buffer) => { /* ... */ });
```

**Problem Details**:
- Each reconnection adds new event listeners to a new WebSocket
- Old WebSocket instances may still have listeners attached
- EventEmitter has no listener limit set
- Circular references between connection and handlers

**Impact**: Memory leak, EventEmitter warning, performance degradation

---

### 9. Promise Rejection in Closed State

**Location**: `SocketConnection.ts` - `get()` method

**Issue**: Promises created before close are never rejected.

```typescript
get(): Promise<T> {
    // ...
    return new Promise((resolve, reject) => {
        this.observers.push(resolve);
        this.rejectors.push(reject);
    });
}

close() {
    this.isClosed = true;
    this.observers = [];  // Observers lost
    this.rejectors.forEach(reject => reject(new Error('SocketConnection is closed')));
    this.rejectors = [];
}
```

**Problem Details**:
- Observers are cleared without notification
- Only rejectors are notified
- Anyone waiting on `then()` (which uses `get()`) may get stuck
- Inconsistent cleanup between observers and rejectors

**Impact**: Hanging promises, resource leaks, unhandled rejections

---

### 10. Authentication Race Condition

**Location**: `HomeAssistant.ts` - `get_authenticated_ws()` message handler

**Issue**: Messages can arrive before authentication is complete.

```typescript
ws.on('message', (event: MessageEvent) => {
    const data = JSON.parse(event.toString());
    if (data['type'] == 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: this.apiKey }));
    } else if (data['type'] == 'auth_ok') {
        socket.ready();
        // ...
    } else {
        // Messages could arrive here before socket.ready() is called
        const callback = this.callbacks.get(id);
        if (callback) { callback(type, data); }
    }
});
```

**Problem Details**:
- No state tracking for authentication phase
- Messages could be processed before `socket.ready()` is called
- Callbacks could fire before connection is considered "ready"
- No timeout for authentication phase

**Impact**: Out-of-order message processing, missed messages, undefined behavior

---

### 11. JSON Parsing Failures

**Location**: `HomeAssistant.ts` - `get_authenticated_ws()` message handler

**Issue**: JSON parsing errors are not handled.

```typescript
ws.on('message', (event: MessageEvent) => {
    const data = JSON.parse(event.toString());  // Can throw
    // No try-catch around this
});
```

**Problem Details**:
- Malformed messages will crash the message handler
- Binary messages are not handled
- Large messages may cause performance issues
- Parse errors are not logged or recovered from

**Impact**: Connection crash on malformed message, unhandled exceptions

---

### 12. Close Method State Inconsistency

**Location**: `HomeAssistant.ts` - `close()` method

**Issue**: Close method doesn't handle all cleanup properly.

```typescript
close(): Promise<void> {
    this.stopReconnecting();
    this.stopPingPong();
    return this.ws.then(ws => {
        this.ws.close();  // Marks SocketConnection as closed
        ws.close();       // Closes actual WebSocket
    });
}
```

**Problem Details**:
- No cleanup of callbacks Map
- Pending promises are never rejected
- EventEmitter listeners on `this` are not removed
- If `ws.then()` is still pending, close operations are delayed
- No state flag to prevent operations after close

**Impact**: Resource leak, hanging promises, unexpected operations after close

---

### 13. Reconnection Loop on Persistent Failure

**Location**: `HomeAssistant.ts` - `attemptReconnect()` and error handling

**Issue**: Reconnection continues even if authentication consistently fails.

```typescript
} else if (data['type'] == 'auth_invalid') {
    this.logger.error('WebSocket error', data);
    socket.error(data.message);
    // No reconnection prevention here
}

ws.on('close', (code: number, reason: Buffer) => {
    // ...
    if (this.shouldReconnect && code !== 1000 && !this.isReconnecting) {
        this.attemptReconnect();  // Tries to reconnect even after auth failure
    }
});
```

**Problem Details**:
- Authentication failures don't set flags to prevent reconnection
- Invalid credentials cause infinite reconnection loop
- No differentiation between recoverable and non-recoverable errors
- Exponential backoff doesn't help with permanent failures

**Impact**: CPU and network resource waste, log spam, unnecessary load on server

---

### 14. Event Emitter Memory Leak

**Location**: `HomeAssistant.ts` - extends EventEmitter

**Issue**: No maximum listener limit and potential circular references.

```typescript
export class HomeAssistant extends EventEmitter {
    // No setMaxListeners() call
    // Listeners are added but cleanup is not guaranteed
}
```

**Problem Details**:
- Event listeners added via `on()` are never explicitly removed
- No maximum listener limit can lead to warnings
- Circular references between HomeAssistant and event handlers
- Long-running instances accumulate listeners on reconnections

**Impact**: Memory leak, EventEmitter warning, performance degradation

---

### 15. Subscribe Generic Memory Leak

**Location**: `HomeAssistant.ts` - `subscribe_generic()` method

**Issue**: Subscription callbacks are never cleaned up on connection loss.

```typescript
subscribe_generic(type: string, params: any): Promise<EventEmitter> {
    const emitter = new EventEmitter();
    const id = this.cmd.get();
    this.callbacks.set(id, (type: MessageType, data: any) => {
        // Callback remains in Map indefinitely
        if (type == MessageType.RESULT && !data['success']) {
            emitter.emit('error', data['error']);
            this.callbacks.delete(id);  // Only deleted on error
        } else {
            emitter.emit(type, data);
            // Never deleted for events - intentional for subscriptions
        }
    });
    return this.send(id, type, params).then(() => emitter);
}
```

**Problem Details**:
- Subscription callbacks are designed to live forever (for streaming)
- If connection closes, subscriptions are never cleaned up
- No tracking of active subscriptions
- No unsubscribe mechanism on connection loss
- EventEmitters returned to callers continue to exist

**Impact**: Memory leak, stale event handlers, confusion when reconnecting

---

## Summary of Issues by Category

### Race Conditions (5 issues)
1. Reconnection management
2. SocketConnection state transitions
3. Command counter reset
4. Authentication sequence
5. Close operations during reconnection

### Resource Leaks (7 issues)
1. Timeout cleanup failures
2. Callback map not cleaned
3. Duplicate WebSocket connections
4. Ping-pong timeout accumulation
5. WebSocket event listeners
6. EventEmitter listeners
7. Subscription callbacks

### State Management (5 issues)
1. SocketConnection state atomicity
2. Close method incompleteness
3. Authentication phase tracking
4. Connection state after close
5. Reconnection flag coordination

### Error Handling (3 issues)
1. JSON parsing failures
2. Reconnection on persistent failures
3. Promise rejection inconsistencies

---

## Recommendations for Fixes

### Priority 1 - Critical (Prevents Data Loss/Crashes)

1. **Add comprehensive try-catch around JSON parsing**
   - Wrap all `JSON.parse()` calls in try-catch
   - Log parse errors and close connection gracefully
   - Handle binary messages appropriately

2. **Clear all callbacks on connection close**
   - Add `this.callbacks.forEach((cb, id) => reject with ConnectionClosed error)`
   - Clear callbacks Map in `close()` method
   - Reject all pending promises

3. **Proper WebSocket cleanup on reconnection**
   - Call `ws.removeAllListeners()` before creating new connection
   - Ensure `ws.terminate()` is called on old socket
   - Track WebSocket instances to prevent duplicates

### Priority 2 - High (Prevents Memory Leaks)

4. **Implement connection state machine**
   - Add states: DISCONNECTED, CONNECTING, AUTHENTICATING, CONNECTED, CLOSING, CLOSED
   - Make state transitions atomic with mutex/lock mechanism
   - Prevent operations in invalid states

5. **Add comprehensive timeout cleanup**
   - Always clear timeouts in finally blocks or cleanup methods
   - Use a Set to track all active timeouts/intervals
   - Clear all tracked timers on close/reconnection

6. **Implement subscription tracking and cleanup**
   - Maintain a Set of active subscription IDs
   - Clear all subscriptions on connection loss
   - Emit 'unsubscribed' event to subscription EventEmitters
   - Provide unsubscribe helper method

### Priority 3 - Medium (Improves Robustness)

7. **Add authentication timeout**
   - Separate timeout for authentication phase (e.g., 10 seconds)
   - Clear timeout on auth_ok or auth_invalid
   - Reject connection if authentication times out

8. **Prevent reconnection on non-recoverable errors**
   - Don't reconnect on auth_invalid (code 1008)
   - Don't reconnect on normal close (code 1000)
   - Add error code classification (recoverable vs non-recoverable)

9. **Fix ping-pong timeout management**
   - Clear old `pongTimeoutId` before setting new one
   - Track all ping IDs in flight
   - Only trigger timeout if multiple pings fail

10. **Add mutex for reconnection**
    - Use a proper lock mechanism for reconnection guard
    - Ensure only one reconnection attempt can run at a time
    - Clear reconnection timeout when new attempt starts

### Priority 4 - Low (Nice to Have)

11. **Set EventEmitter max listeners**
    - Call `this.setMaxListeners(20)` or appropriate limit
    - Monitor listener count and log warnings

12. **Add connection pooling prevention**
    - Track WebSocket instances in a Set
    - Prevent creating new connection if one exists
    - Add connection ID for debugging

13. **Improve promise resolution guards**
    - Track promise resolution state
    - Prevent double resolve/reject
    - Log warnings on double resolution attempts

14. **Add graceful shutdown sequence**
    - Stop accepting new commands
    - Wait for pending operations to complete (with timeout)
    - Clean up all resources
    - Emit 'shutdown_complete' event

---

## Testing Recommendations

To validate fixes for these corner cases, implement tests for:

1. **Rapid connect/disconnect cycles** - Verify no resource leaks
2. **Connection loss during pending requests** - Verify promises are rejected
3. **Malformed message handling** - Verify no crashes
4. **Authentication failure scenarios** - Verify no infinite loops
5. **Concurrent operation attempts** - Verify state consistency
6. **Long-running connections** - Verify no memory growth
7. **Reconnection under various failure modes** - Verify proper cleanup

---

## Conclusion

The current implementation has several critical issues that could lead to:
- Memory leaks in long-running applications
- Race conditions under high load or network instability
- Resource exhaustion from leaked timers and connections
- Data corruption from ID collisions
- Application crashes from unhandled errors

These issues are particularly problematic in production environments with:
- Unstable network connections
- High message volumes
- Long-running processes
- Limited resources (embedded systems, containers)

Implementing the recommended fixes will significantly improve the robustness, reliability, and production-readiness of the WebSocket connection management system.
