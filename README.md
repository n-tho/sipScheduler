# SIP Scheduler App

## Purpose

The **SIP Scheduler App** is an innovaphone AppService designed to **temporarily disable and reliably re‑enable SIP interfaces (trunks)** on an innovaphone device based on a schedule.

Its primary goal is to make **planned SIP outages** (for maintenance, provider re‑registration, routing changes, etc.) **safe, deterministic, and recoverable**, even in the presence of crashes or restarts.

---

## Key Features

-  **Time‑based execution**

  - Runs daily at a configured `run_at` time
  - Automatically reschedules on configuration changes
-  **Controlled SIP disable / restore**

  - Disables selected SIP interfaces (via bitmask)
  - Restores the *exact previous state* after a configurable hold time
-  **Crash‑safe state handling**

  - Runtime state is persisted in a database
  - SIP interfaces are always restored, even after:
    - AppService crash
    - PBX restart
    - Network interruptions
-  **Safe by design**

  - Never permanently disables a trunk unintentionally
  - Prevents overlapping jobs while a hold is active
  - Uses previous SIP state snapshots for precise restore
-  **Transparent logging**

  - Clear logs for:
    - scheduling decisions
    - hold start and restore time
    - recovery after restart

---

## Conceptual Design

The app deliberately separates **configuration** from **runtime state**:

### Configuration (Config Items)

Configuration defines *what should happen*:

- when the job runs
- which SIP interfaces are affected
- how long the disable (hold) lasts
- which device is controlled

Configuration is **static**, admin‑managed, and never modified at runtime.

### Runtime State (Database)

The database stores *what is currently happening*:

- whether a hold is active
- which SIPs were modified
- the original disabled/enabled state
- when restoration must occur

This ensures the system can always recover correctly.

---

## Typical Use Cases

- Planned SIP provider maintenance windows
- Forcing clean SIP re‑registrations
- Temporary routing isolation
- Nightly or scheduled trunk resets
- Controlled failover testing

---

## Operational Safety Guarantee

> If the app disables a SIP interface, it will always attempt to restore it.

This guarantee holds even if the AppService or PBX is restarted during the hold phase.

---

## Compatibility

- innovaphone App Platform (15r1+)
- ES5‑compatible JavaScript
- Uses standard innovaphone APIs (Config, Database, AppWebsocket)

---

## Summary

The SIP Scheduler App provides a **robust, production‑safe mechanism** to automate SIP trunk disable/enable cycles without risking permanent outages or manual recovery work.

It is designed for operators who value **predictability, transparency, and operational safety**.
