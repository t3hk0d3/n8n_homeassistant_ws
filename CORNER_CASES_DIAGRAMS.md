# Visual Corner Case Diagrams

This document provides visual representations of the key corner cases identified in the analysis.

---

## 1. Reconnection Race Condition

```
Timeline: Multiple Close Events
═════════════════════════════════════════════════════════════

Thread/Event 1:          Thread/Event 2:          Thread/Event 3:
close event              close event              close event
    ↓                        ↓                        ↓
check isReconnecting     check isReconnecting     check isReconnecting
(false)                  (false)                  (false)
    ↓                        ↓                        ↓
set isReconnecting       set isReconnecting       set isReconnecting
= true                   = true                   = true
    ↓                        ↓                        ↓
setTimeout()             setTimeout()             setTimeout()
creates Timer A          creates Timer B          creates Timer C
    ↓                        ↓                        ↓
[LEAK: 3 timers, 3 reconnection attempts]
```

**Fix**: Use proper mutex/lock mechanism

---

## 2. Callback Map Memory Leak

```
Connection Lifecycle
═══════════════════════════════════════════════════════

Normal Flow:
┌─────────────┐
│ send(id: 1) │──→ callbacks.set(1, handler)
└─────────────┘
      │
      ↓
┌─────────────┐
│  response   │──→ handler called
└─────────────┘    callbacks.delete(1) ✓
      │
      ↓
   [clean]


Connection Loss Flow:
┌─────────────┐
│ send(id: 1) │──→ callbacks.set(1, handler)
│ send(id: 2) │──→ callbacks.set(2, handler)
│ send(id: 3) │──→ callbacks.set(3, handler)
└─────────────┘
      │
      ↓
┌─────────────┐
│ CONNECTION  │
│   CLOSED    │──→ callbacks still has [1, 2, 3] ✗
└─────────────┘    promises never resolved/rejected
      │            memory leaked
      ↓
  [LEAK: 3 handlers, 3 promises stuck]
```

**Fix**: Clear callbacks on connection close with rejection

---

## 3. Ping-Pong Timeout Accumulation

```
Timing Diagram
═══════════════════════════════════════════════════════

t=0s:   sendPing()
        ├─→ pongTimeoutId = setTimeout(handleTimeout, 10s) [Timer A]
        └─→ send ping message

t=5s:   pong received
        └─→ clearTimeout(pongTimeoutId) [Timer A cleared] ✓

t=30s:  sendPing()
        ├─→ pongTimeoutId = setTimeout(handleTimeout, 10s) [Timer B]
        └─→ send ping message

t=35s:  sendPing() [called early due to manual trigger]
        ├─→ pongTimeoutId = setTimeout(handleTimeout, 10s) [Timer C]
        │   [Timer B is LOST - not cleared!] ✗
        └─→ send ping message

t=45s:  Timer B fires! → false timeout ✗
        └─→ triggers reconnection unnecessarily

t=45s:  pong received
        └─→ clearTimeout(pongTimeoutId) [Timer C cleared]
             [Timer B already fired] ✗

[LEAK: Timer B leaked and caused false timeout]
```

**Fix**: Always clear old timeout before setting new one

---

## 4. Double WebSocket Creation

```
Reconnection Flow
═══════════════════════════════════════════════════════

Initial State:
┌──────────────────┐
│ WebSocket A      │ ← ws (SocketConnection)
│ - listeners: 3   │
│ - state: OPEN    │
└──────────────────┘

Reconnection Triggered:
┌──────────────────┐
│ ws.close()       │ ← only sets isClosed flag
└──────────────────┘
         │
         ↓
┌──────────────────┐
│ WebSocket A      │ ← still exists!
│ - listeners: 3   │ ← still attached!
│ - state: OPEN    │ ← still open!
└──────────────────┘

         │
         ↓
┌──────────────────┐
│ ws = new WS()    │ ← creates new WebSocket B
└──────────────────┘
         │
         ↓
┌──────────────────┐     ┌──────────────────┐
│ WebSocket A      │     │ WebSocket B      │
│ - listeners: 3   │     │ - listeners: 3   │
│ - state: OPEN    │     │ - state: OPEN    │
│ [LEAKED!] ✗     │     │ (active) ✓       │
└──────────────────┘     └──────────────────┘

[LEAK: WebSocket A never terminated, listeners never removed]
```

**Fix**: Call `ws.removeAllListeners()` and `ws.terminate()` first

---

## 5. Command Counter ID Collision

```
Scenario: Reconnection with Pending Callbacks
═══════════════════════════════════════════════════════

Before Reconnection:
┌─────────────────────────────┐
│ callbacks Map:              │
│   1 → handler_get_states    │
│   2 → handler_get_devices   │
│   3 → handler_subscribe     │
└─────────────────────────────┘
│ cmd.counter = 4             │
└─────────────────────────────┘

Reconnection:
┌─────────────────────────────┐
│ cmd.reset()                 │ ← resets counter to 1
└─────────────────────────────┘

After Reconnection:
┌─────────────────────────────┐
│ callbacks Map:              │
│   1 → handler_get_states    │ ← OLD handler
│   2 → handler_get_devices   │ ← OLD handler
│   3 → handler_subscribe     │ ← OLD handler
└─────────────────────────────┘
│ cmd.counter = 1             │ ← RESET!
└─────────────────────────────┘

New Request:
┌─────────────────────────────┐
│ send_with_response(...)     │
│ ├─→ id = cmd.get()  (= 1)  │
│ └─→ callbacks.set(1, NEW)  │ ← OVERWRITES OLD!
└─────────────────────────────┘

Response Arrives:
┌─────────────────────────────┐
│ response with id: 1         │
│ ├─→ get callbacks.get(1)   │
│ └─→ calls NEW handler       │ ← Wrong handler!
│     with data meant for OLD │ ← Data mismatch!
└─────────────────────────────┘

[BUG: Wrong data routed to wrong handler]
```

**Fix**: Clear callbacks before resetting counter

---

## 6. SocketConnection State Race

```
Timing Diagram: Race Condition in get()
═══════════════════════════════════════════════════════

Thread 1:                    Thread 2:
get() called                 ready() called
    ↓                            ↓
check isReady (false)        this.isReady = true
    ↓                            ↓
check isClosed (false)       observers.forEach(resolve)
    ↓                            ↓
check isError (false)        observers = []
    ↓                            ↓
create Promise               [done]
    ↓
observers.push(resolve)  ← pushed to EMPTY array!
    ↓
[STUCK: Promise never resolved because observers
 was cleared before we added our resolve]
```

**Fix**: Use atomic operations or locks

---

## 7. Complete System State Diagram

```
HomeAssistant Connection States
═══════════════════════════════════════════════════════

                    ┌─────────────┐
                    │ INITIALIZED │
                    └──────┬──────┘
                           │
                    constructor()
                           │
                           ↓
                    ┌─────────────┐
              ┌────→│ CONNECTING  │←────┐
              │     └──────┬──────┘     │
              │            │             │
              │     ws.on('open')       │
              │            │             │
              │            ↓             │
              │     ┌──────────────┐    │
              │     │AUTHENTICATING│    │
              │     └──────┬───────┘    │
              │            │             │
     close()  │      auth_ok/auth_invalid│
              │            │             │
              │            ↓             │
              │     ┌─────────────┐     │
              │ ┌──→│  CONNECTED  │     │ attemptReconnect()
              │ │   └──────┬──────┘     │
              │ │          │             │
              │ │   normal operations    │
              │ │          │             │
              │ │          ↓             │
              │ │   ┌─────────────┐     │
              │ └───│   CLOSING   │     │
              │     └──────┬──────┘     │
              │            │             │
              │        ws.close()        │
              │            │             │
              ↓            ↓             │
         ┌──────────┐  ┌──────────┐    │
         │  CLOSED  │←─│ FAILED   │────┘
         └──────────┘  └──────────┘

Current Issue: No explicit state tracking!
- States are implicit via flags (isReconnecting, shouldReconnect)
- Multiple paths can lead to undefined states
- No validation of allowed state transitions
```

**Fix**: Implement explicit state machine

---

## 8. Resource Leak Timeline

```
Memory Leak Over Time
═══════════════════════════════════════════════════════

Time:  0m    30m    60m    90m    120m
       │     │      │      │      │
       ↓     ↓      ↓      ↓      ↓

Callbacks Map:
Size:  0     5      12     25     45  ← growing!
       ░     ░░     ░░░░   ░░░░░░ ░░░░░░░░

Timeouts:
Count: 0     2      5      8      12  ← growing!
       ◯     ◯◯     ◯◯◯◯◯  ◯◯◯◯◯◯ ◯◯◯◯◯◯◯◯

WebSocket Listeners:
Count: 3     6      9      12     15  ← growing!
       ╫╫╫   ╫╫╫╫╫╫ ╫╫╫╫╫╫ ╫╫╫╫╫╫ ╫╫╫╫╫╫╫╫╫

Memory:
Usage: 10MB  15MB   25MB   40MB   60MB ← growing!
       ▓▓    ▓▓▓▓   ▓▓▓▓▓▓ ▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓

Each reconnection adds:
- 3 event listeners (message, error, close)
- 1-2 pending callbacks
- 2-3 active timeouts (ping, pong, reconnect)
- Previous WebSocket not terminated

After 120m with 5 reconnections:
- 15 event listeners (3 per connection)
- 45 callbacks (9 pending per connection)
- 12 timeouts (2-3 per connection)
- 5 zombie WebSockets

[CRITICAL: Unbounded growth leads to OOM]
```

---

## 9. Subscription Lifecycle Issue

```
Subscription Flow
═══════════════════════════════════════════════════════

Client creates subscription:
┌──────────────────────────┐
│ subscribe_events('state')│
└────────────┬─────────────┘
             │
             ↓
┌──────────────────────────┐
│ id = 42                  │
│ callbacks.set(42, ...)   │
│ return EventEmitter      │
└────────────┬─────────────┘
             │
             ↓
┌──────────────────────────┐
│ Client code:             │
│ emitter.on('event', ...) │
└────────────┬─────────────┘
             │
      [Working correctly]
             │
             ↓
┌──────────────────────────┐
│  Connection Lost!        │
└────────────┬─────────────┘
             │
             ↓
┌──────────────────────────┐
│ callback(42) still in    │
│ callbacks Map ✗          │
│                          │
│ emitter still has        │
│ listener ✗               │
│                          │
│ No cleanup happened! ✗   │
└────────────┬─────────────┘
             │
             ↓
┌──────────────────────────┐
│ Reconnection happens     │
│ New subscription needed  │
│ but old one still exists!│
└──────────────────────────┘

Problem: Subscriptions are never tracked or cleaned up
Result: Memory leak, zombie event listeners, confusion
```

**Fix**: Track subscriptions in Set, clean on disconnect

---

## 10. Authentication Flow Issues

```
Message Processing Order Issue
═══════════════════════════════════════════════════════

Normal Flow (Expected):
┌────────────────┐
│ WebSocket open │
└───────┬────────┘
        │
        ↓
┌────────────────┐
│ auth_required  │ ← Server sends
└───────┬────────┘
        │
        ↓
┌────────────────┐
│ send auth      │ ← Client sends
└───────┬────────┘
        │
        ↓
┌────────────────┐
│ auth_ok        │ ← Server confirms
└───────┬────────┘
        │
        ↓
┌────────────────┐
│ socket.ready() │ ← Mark as ready
└───────┬────────┘
        │
        ↓
┌────────────────┐
│ normal msgs    │ ← Process messages
└────────────────┘


Race Condition Flow (Possible):
┌────────────────┐
│ WebSocket open │
└───────┬────────┘
        │
        ↓
┌────────────────┐
│ auth_required  │
└───────┬────────┘
        │
        ↓
┌────────────────┐
│ send auth      │
└───────┬────────┘
        │
        ├─────────────────────┐
        │                     │
        ↓                     ↓
┌────────────────┐   ┌────────────────┐
│ auth_ok        │   │ result msg     │ ← Early message!
└───────┬────────┘   └───────┬────────┘
        │                     │
        │                     ↓
        │            ┌────────────────┐
        │            │ process msg    │ ← BEFORE ready!
        │            │ callback(...)  │ ← May fail!
        │            └────────────────┘
        │
        ↓
┌────────────────┐
│ socket.ready() │ ← Too late!
└────────────────┘

[BUG: Messages processed before connection marked ready]
```

**Fix**: Buffer messages during auth, process after ready

---

## Summary Visual: Issue Interconnections

```
Issue Dependency Graph
═══════════════════════════════════════════════════════

                    ┌──────────────────┐
                    │ No State Machine │
                    └────────┬─────────┘
                             │ causes
                ┌────────────┼────────────┐
                │            │            │
                ↓            ↓            ↓
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │  Race    │  │ Resource │  │ Callback │
        │Conditions│  │  Leaks   │  │  Leaks   │
        └────┬─────┘  └────┬─────┘  └────┬─────┘
             │             │             │
             ├─────────────┼─────────────┤
             │             │             │
             ↓             ↓             ↓
        ┌─────────────────────────────────┐
        │     Memory Growth Over Time     │
        └────────────┬────────────────────┘
                     │
                     ↓
        ┌─────────────────────────────────┐
        │   Application Crash / OOM       │
        └─────────────────────────────────┘

Fix Strategy: Bottom-Up
1. Implement state machine (foundation)
2. Fix resource cleanup (prevents leaks)
3. Add proper guards (prevents races)
4. Add comprehensive tests (validates fixes)
```

---

**Document Version**: 1.0  
**Purpose**: Visual supplement to corner case analysis  
**Usage**: Use these diagrams in presentations and documentation
