# Remote Desktop Agent & Central Control Panel

**Document purpose:** Define a professional, end-to-end plan to move from “developers run this repo locally” to **installable desktop software** on end-user machines that **registers with your central panel**, so operators can **open positions manually** and **run workers (e.g. Fixed Lot)** remotely—without shipping source code or asking users to install Rust/Node/Python tooling.

**Status:** Planning only. **No implementation** until explicitly approved.

---

## Feasibility assurance (read this first)

### Is this plan technically valid?

**Yes.** The architecture described here—**central control plane + outbound‑connected desktop agent + local MetaTrader execution**—is the standard, proven way to operate when the trading API is **bound to the user’s machine** (as MT5 automation typically is). Nothing in this document relies on unsupported physics or broker‑impossible behavior.

### Will it “work 100%”?

**Not a meaningful promise in engineering terms**, and you should treat anyone who guarantees 100% end‑to‑end trading outcomes as a red flag.

What **can** be made highly reliable (with solid engineering and operations):

- **Your** services: authentication, device registry, command queue, audit trail, panel UX, monitoring.
- **The control path** under normal conditions: operator issues command → cloud delivers → agent executes → result recorded (target **high success rate**, e.g. 99.9%+ *for your infrastructure*, excluding external failures).

What **cannot** be guaranteed at 100% (outside your software’s control):

- **Brokers and MT5**: rejects, requotes, disconnects, maintenance, symbol/session changes.
- **End‑user environment**: PC asleep, antivirus blocking the agent, MT5 closed, wrong account, “Algo Trading” off, Windows updates, disk full.
- **Network**: ISP outages, corporate proxies, DNS issues, regional routing.
- **Compliance / legal**: suitability of remote control for your jurisdiction and use case.

**Professional wording you can use internally:**  
*“The design is sound and implementable. We target production‑grade reliability for our stack and clear degradation behaviors when MT5, the network, or the broker fails.”*

### What “success” means for this project

See [§20 Success criteria](#20-success-criteria-definition-of-done) and [§21 Risk register](#21-risk-register--plan-invalidators).

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Goals and non-goals](#2-goals-and-non-goals)
3. [Why a desktop agent is required](#3-why-a-desktop-agent-is-required)
4. [High-level architecture](#4-high-level-architecture)
5. [Components in detail](#5-components-in-detail)
6. [Data flows](#6-data-flows)
7. [Security model](#7-security-model)
8. [Identity, tenancy, and permissions](#8-identity-tenancy-and-permissions)
9. [API & real-time contracts (conceptual)](#9-api--real-time-contracts-conceptual)
10. [Worker scheduling: where logic lives](#10-worker-scheduling-where-logic-lives)
11. [Desktop agent: technology options](#11-desktop-agent-technology-options)
12. [Packaging, distribution, and updates](#12-packaging-distribution-and-updates)
13. [Observability, logging, and support](#13-observability-logging-and-support)
14. [Reliability and failure modes](#14-reliability-and-failure-modes)
15. [Compliance, risk, and legal considerations](#15-compliance-risk-and-legal-considerations)
16. [Phased delivery plan](#16-phased-delivery-plan)
17. [Mapping from the current codebase](#17-mapping-from-the-current-codebase)
18. [Open decisions (need your input)](#18-open-decisions-need-your-input)
19. [Technical assumptions & prerequisites](#19-technical-assumptions--prerequisites)
20. [Success criteria (definition of done)](#20-success-criteria-definition-of-done)
21. [Risk register & plan invalidators](#21-risk-register--plan-invalidators)
22. [Appendix: example command schemas](#appendix-example-command-schemas)

---

## 1. Executive summary

Today, the MT5 Panel project assumes the **API and Python bridge run on the same machine** as MetaTrader 5 (or on a network path you control), and operators use a local browser UI.

The target model is:

- **Central Cloud** hosts your authoritative API, database, authentication, device registry, command queue, and audit trail.
- **Desktop Agent** is installed on each trader’s PC. It connects outbound to the cloud, keeps MT5 linked locally, executes trade commands, and streams status back.
- **Web Panel** (existing or evolved) talks only to the **central cloud**, not to random user IPs.

This is standard for remote execution against **local-only trading APIs** such as MT5.

---

## 2. Goals and non-goals

### Goals

- **No code handoff:** End users install a signed package (installer), not a dev environment.
- **Central visibility:** Devices show online/offline, account info, last heartbeat, versions.
- **Remote control:** Manual orders and worker-style automation triggered from **your** panel.
- **Exness (and other brokers) via MT5:** Same as now—execution remains through the user’s local MT5 terminal(s).
- **Safety controls:** Limits, kill switch, audit logs, permissioning.

### Non-goals (initially)

- **Executing trades without any local agent** (not technically possible with MT5’s normal integration model).
- **Guaranteed tick-perfect copy trading** across unrelated brokers (requires separate product design and broker-specific constraints).
- **Mobile-only agent** (possible later; desktop is the practical first target for MT5 on Windows).

---

## 3. Why a desktop agent is required

MetaTrader 5 terminals are **local applications**. The typical integration path used by this project is:

- Local Python (`MetaTrader5` package) or similar **only works where MT5 is running** (and where terminal permissions allow algorithmic trading).

Therefore:

- Your cloud cannot “directly click Buy” inside a user’s MT5 session.
- You **must** have a trusted local component that performs `order_send` (or equivalent) on behalf of authenticated remote commands.

---

## 4. High-level architecture

```text
┌──────────────────────────┐         HTTPS/WSS          ┌──────────────────────────┐
│   Operator Web Panel     │ ◄────────────────────────► │   Central API + Realtime │
│   (React/Vite, hosted)   │                             │   (Rust/Node/Go/etc.)    │
└──────────────────────────┘                             └─────────────┬────────────┘
                                                                         │
                                                                         │ Postgres/Redis
                                                                         │
                                                               ┌─────────▼─────────┐
                                                               │  Auth / Audit DB  │
                                                               └───────────────────┘

                                                         WSS (outbound) / HTTPS
┌──────────────────────────┐                             ┌──────────────────────────┐
│ MetaTrader 5 Terminal    │ ◄── local IPC / Python ───► │ Desktop Agent (Windows) │
│ (user laptop)            │                             │ - executes commands       │
└──────────────────────────┘                             │ - streams status          │
                                                         └──────────────────────────┘
```

**Key principle:** Agents initiate **outbound** connections to the cloud (firewall friendly).

---

## 5. Components in detail

### 5.1 Central Cloud

Responsibilities:

- **Authentication & authorization** for operators (your team) and optionally device owners.
- **Device registry:** device id, labels, MT5 terminal mapping, installed agent version, public key (if used).
- **Command plane:** enqueue commands, track state (`pending`, `ack`, `executing`, `success`, `failed`, `expired`).
- **Telemetry ingestion:** heartbeats, positions snapshots (or deltas), symbol lists, errors.
- **Realtime fan-out:** push command updates + market/positions updates to subscribed operators.
- **Audit/logging:** immutable records of who issued what and what happened.

Suggested backing services:

- **PostgreSQL** for durable records (users, devices, commands, audit).
- **Redis** (optional) for queues, rate limits, ephemeral presence.
- **Object storage** (optional) for agent log bundles.

### 5.2 Operator Web Panel

Responsibilities:

- Same UX patterns as today: pick target device/account, symbols, volumes, workers.
- Instead of calling `http://localhost:3001`, it calls `https://api.yourdomain.com`.
- Subscribes to websocket channels for live updates.

### 5.3 Desktop Agent

Responsibilities:

- Launch on startup (Windows Service + optional tray UI).
- **Pairing/registration** with the cloud (one-time).
- Maintain **secure session** (token refresh, rotation).
- Poll or subscribe for **commands** targeted at this device.
- Execute:

  - `list_accounts` / `list_symbols` / `list_positions`
  - `place_market_order`
  - `close_positions` (selected, all, by ticket—depending on policy)
  - `worker_tick` (if you centralize scheduling) or local scheduled work (not preferred for multi-operator control)

- Report results with structured errors (MT5 retcodes, bridge exceptions, throttling).
- Local policy enforcement (hard caps): max lot, max daily trades, disabled symbols, etc.

---

## 6. Data flows

### 6.1 Device registration (pairing)

Typical UX:

1. Operator creates a **pairing code** in panel (short TTL, e.g. 10 minutes).
2. User enters pairing code in agent installer/first-run wizard.
3. Cloud binds device to organization, issues **device credential** (or mutual trust keys).

Alternative: email invite link with embedded token (still ends in local agent enrollment).

### 6.2 Heartbeat / presence

Agent sends heartbeat every N seconds:

- agent version / OS / timezone
- MT5 connectivity status
- selected account identifiers (broker login if allowed by policy)
- queue depth / last command id processed

Cloud marks device **online** if heartbeat within timeout.

### 6.3 Manual trade command

1. Operator submits trade form in panel.
2. Cloud validates permissions + risk policy.
3. Cloud enqueues `PlaceOrder` command to device queue.
4. Agent receives command, executes locally via MT5 bridge.
5. Agent returns structured result; cloud stores audit event; UI updates.

### 6.4 Worker / Fixed Lot–style automation

Recommended approach for “control from our panel”:

- **Scheduler runs in the cloud** (cron-like or event-driven), *or* is triggered by operator toggles.
- Cloud emits periodic `WorkerRun` commands according to the configured distribution (randomized intervals, volume bounds, symbol pools).
- Agent executes each run as a deterministic mini-program:

  - fetch positions (or use cached)
  - decide skip rules (max open positions)
  - choose symbol + side + volume
  - place order
  - return summary

This mirrors your current `#fixedlot` behavior but centralizes authority.

---

## 7. Security model

### 7.1 Transport security

- TLS 1.2+ everywhere (`https://`, `wss://`).
- Certificate pinning in agent (optional hardening; tradeoffs with rotation).

### 7.2 Authentication

Minimum viable:

- Operator auth: email + MFA recommended.
- Device auth: per-device API key / refresh token issued at pairing.

Stronger:

- Short-lived JWT for device + refresh token storage in OS credential vault.
- Optional **device public key**: cloud encrypts command payloads for that device.

### 7.3 Authorization

- Role-based access control (RBAC):

  - `superadmin`, `operator`, `viewer`, `device_owner` (if you sell B2B)

- Command-level permissions:

  - who can trade
  - who can close positions
  - who can change risk limits

### 7.4 Command integrity & replay protection

Commands should include:

- `command_id` (UUID)
- `issued_at` timestamp
- `nonce`
- optional signature (server-side HMAC using device secret)

Agent must reject:

- expired commands
- duplicated `command_id`
- out-of-order critical commands unless explicitly allowed

### 7.5 Local security on user laptop

- Run agent with least privilege; elevate only if required.
- Store secrets using **Windows Credential Manager** or DPAPI.
- Protect against tampering: signed binaries, update verification.
- “Panic disable” when integrity checks fail.

---

## 8. Identity, tenancy, and permissions

### 8.1 Multi-tenant model (recommended)

Entities:

- **Organization** (your customer / desk)
- **Operator users** belong to org
- **Devices** belong to org
- Optional **subaccounts** within org (teams)

### 8.2 Device identity

Each device gets:

- stable `device_id`
- human label (“Ahmed laptop”, “Office PC 2”)
- version reporting

### 8.3 Mapping MT5 accounts to panel target

You need explicit mapping rules:

- Many users run multiple terminals; your current code uses `account_id` strings mapped to terminal paths.
- In cloud model, mapping must be:

  - stored per device (path + account id), or
  - detected and confirmed by operator once, stored as canonical `mt5_terminal_key`.

---

## 9. API & real-time contracts (conceptual)

This section defines **what** to implement, not exact endpoint paths (those can vary).

### 9.1 REST (operators)

Examples:

- `POST /v1/auth/login`
- `GET /v1/devices`
- `POST /v1/devices/pairing-codes`
- `POST /v1/commands/place-order`
- `GET /v1/commands/{id}`
- `GET /v1/audit?...`

### 9.2 Device-facing API

Preferred patterns:

- `POST /v1/device/heartbeat`
- `GET /v1/device/commands/next` (long-poll) **or**
- `WSS /v1/device/stream` (recommended)

### 9.3 Realtime to panel

- `WSS /v1/panel/stream`

Events:

- `device.presence`
- `command.updated`
- `positions.snapshot` (optional; consider privacy + bandwidth)

---

## 10. Worker scheduling: where logic lives

### Option A (recommended): Cloud schedules, agent executes

**Pros**

- Single source of truth; operators see the same schedule; easy audit.
- You can pause globally, throttle, or set maintenance mode.

**Cons**

- Requires reliable timestamps and timezone clarity.
- Network outages must be handled (agent queues or marks worker degraded).

### Option B: Agent schedules locally

**Pros**

- Works offline longer (but trading still needs broker connectivity).

**Cons**

- Harder to enforce consistent policy from panel; drift between devices.

**Project recommendation:** Option A for anything you label “worker”.

---

## 11. Desktop agent: technology options

### 11.1 Phase 1 — fastest path (Python + PyInstaller)

**Pros**

- Reuses your existing `python_bridge` approach and team familiarity.
- Rapid MVP.

**Cons**

- Packaging size; AV false positives if not signed properly.
- Service lifecycle nuances on Windows.

### 11.2 Phase 2 — production-grade agent (Rust or .NET)

**Pros**

- Windows service integration, robust auto-update, strong performance.
- Easier control over security and dependencies.

**Cons**

- Higher upfront engineering.

**Recommendation:** plan for Python MVP, architect cloud contracts so the agent can be rewritten without changing the protocol.

---

## 12. Packaging, distribution, and updates

### Code signing

- Sign installers and binaries with a trusted cert to reduce SmartScreen warnings.

### Auto-update

- Agent checks `GET /v1/agent/release?channel=stable`
- Downloads signed manifest + artifacts
- Applies update on idle / restarts service

### Support tooling

- “Export diagnostics” button: agent version, last errors, MT5 status, recent commands (redacted).

---

## 13. Observability, logging, and support

### Central logs

- structured logs (JSON) from cloud services
- per-command traces

### Agent logs

- ring buffer locally + optional upload with user consent (`diagnostics bundle`)

### Metrics

- command success rate, latency distribution
- device online percentage
- MT5 error code histogram (retcodes)

---

## 14. Reliability and failure modes

| Failure | Desired behavior |
|--------|-------------------|
| Internet down | Agent queues limited commands or stops worker safely; resumes when online |
| MT5 closed / not logged in | Agent reports `mt5_unavailable`; panel shows blocked state |
| Broker rejects order | Return retcode + message; audit entry; UI alerts |
| Clock skew | Use server time for expiry; agent includes local time for debugging |
| Malicious operator token stolen | MFA + short session + IP allowlist optional |

---

## 15. Compliance, risk, and legal considerations

This is not legal advice. For a system that allows remote placement of trades on a user machine, you should address:

- **User consent** and terms (remote control of trading software).
- **Who is liable** for losses due to automation, latency, or misconfiguration.
- **Data privacy** (IPs, account numbers, trading history storage).
- **Regional regulations** governing investment services, “trading bots”, and account management.

Operational risk controls:

- hard caps, kill switch, dual approval for large orders (future)

---

## 16. Phased delivery plan

### Phase 0 — Product definition (1–2 weeks)

- Define roles, device pairing UX, risk limits, audit needs.
- Decide hosting provider and domain.

### Phase 1 — MVP: command + presence (2–6 weeks depending on team)

- Cloud auth + DB
- Device pairing + heartbeat
- Single command: place market order + return result
- Panel page: device list + minimal trade form

### Phase 2 — Parity with current panel features (4–10 weeks)

- symbols + positions snapshots
- close positions
- integrate Fixed Lot worker via cloud scheduling
- improved error reporting + retries

### Phase 3 — Production hardening (ongoing)

- auto-update, signing, monitoring, on-call runbooks
- scaling, rate limits, multi-region (if needed)

Estimates vary widely based on team size and whether you extend the existing Rust API vs rebuild a dedicated cloud service.

---

## 17. Mapping from the current codebase

Today (simplified):

- `frontend/` — Vite/React UI; calls `/api` which is proxied to local Rust API.
- `backend/` — Rust Axum API; shells/imports Python bridge for MT5 operations.
- `python_bridge/` — MT5 integration scripts.

Tomorrow:

- **Desktop agent** contains the MT5 execution responsibilities currently satisfied by running API+bridge on the same host as MT5.
- **Central cloud** becomes the API the panel calls.
- Your existing UI logic for forms/workers becomes clients of **cloud endpoints**, not localhost.

You can still reuse:

- Worker rules and validation concepts from `FixedLot.tsx` (as product requirements).
- Rust patterns for API design (but likely deployed remotely).
- Python bridge as the first agent runtime.

---

## 18. Open decisions (need your input)

1. **Hosting:** Which cloud/VPS and target region(s)?
2. **Tenancy:** Only your internal desk, or multiple external customers?
3. **Identity:** Will end users log into the panel, or only your operators?
4. **Privacy:** Do you want cloud to store positions history full-time or ephemeral?
5. **Broker scope:** Only Exness/MT5, or multiple terminal installs per device?
6. **Scaling:** Expected concurrent devices (10, 100, 1000+)?
7. **Approval workflow:** Require two-person approval for trading commands?

---

## 19. Technical assumptions & prerequisites

The plan **holds** when these assumptions are true. If any are false, the architecture still works, but you must adjust design (called out in [§21](#21-risk-register--plan-invalidators)).

### End-user / MT5 side

| Assumption | Why it matters |
|------------|----------------|
| **Windows desktop** (initially) | MT5 automation via Python API is overwhelmingly used on Windows in your scenario; macOS/Linux agents are a separate product spike. |
| **MT5 installed, logged in, Algo Trading enabled** | Without this, *no* automation (local or remote) can place orders reliably. |
| **Symbols available / subscribed** as today | Same constraints as your current `python_bridge`: symbols must exist in Market Watch / be addable. |
| **Stable mapping** from “panel account key” → correct terminal instance | Your project already uses multiple terminals; cloud must preserve per‑device configuration. |
| **User allows outbound HTTPS/WSS** to your cloud | Corporate firewalls may require proxy support or IT allowlisting. |

### Your cloud / operations

| Assumption | Why it matters |
|------------|----------------|
| **Always-on API** + TLS certificate | Public panel and agents need a stable hostname. |
| **Durable database** for devices, commands, audit | Required for trust, debugging, and compliance arguments. |
| **Tolerable latency** | Remote control adds round‑trip delay vs localhost; still typically sub‑second to seconds—not tick HFT, but fine for manual + periodic worker. |
| **Monitored deployments** | Production reliability requires logs, alerts, backups, update discipline. |

### Security posture

| Assumption | Why it matters |
|------------|----------------|
| **Device compromise = trade compromise** | The agent is “root of trust” on that PC; reduce blast radius with caps, kill switch, logging, MFA on operators. |
| **Signed installers** | Expect AV and SmartScreen scrutiny; signing and reputation matter. |

---

## 20. Success criteria (definition of done)

Use these as objective checkpoints so “it works” is not ambiguous.

### Phase 1 (MVP) — done when:

- [ ] A fresh Windows PC can install the agent **without** installing src/Node/Rust.
- [ ] Device pairs to your org via **short‑lived pairing code** (or equivalent).
- [ ] Panel shows device **online/offline** within agreed heartbeat SLA (e.g. under 60 seconds staleness).
- [ ] Operator can place **one market order** remotely and receives **structured success/failure** (including MT5 retcode when applicable).
- [ ] Command is **audited** (who/when/what/result).
- [ ] MT5 offline / agent stopped produces a **clear blocked state** in the panel—not a silent failure.

### Phase 2 (Fixed Lot parity) — done when:

- [ ] Symbols and positions can be inspected from the panel for a selected device (subject to privacy policy).
- [ ] **Worker scheduling** is driven from cloud (or operator toggle), agent executes ticks deterministically.
- [ ] `max_open_positions` and volume bounds are enforced **server-side policy + agent-side hard caps** (defense in depth).
- [ ] Load tests on expected **N concurrent devices** without command backlog runaway.

### Production readiness — done when:

- [ ] **Auto-update** or documented update process; version skew tracked.
- [ ] **Runbook** for incident response (disable device, revoke credential, freeze trading org‑wide).
- [ ] **Backups + restore** tested for DB.
- [ ] **Security review** (threat model + pen test as appropriate for your exposure).

---

## 21. Risk register & plan invalidators

These are the main reasons projects like this **fail in practice**—not because the architecture is wrong, but because reality bites.

| Risk | Mitigation (summary) |
|------|----------------------|
| **Users won’t run MT5 reliably** | Clear prerequisites UI; device health screen; refuse commands with explicit errors. |
| **Antivirus blocks agent** | Code signing, reputation, support playbook, optional AV allowlist instructions. |
| **Broker / MT5 behavior changes** | Versioned agent, integration tests against demo accounts, retcode mapping table. |
| **Command duplication / replay** | Idempotent `command_id`, expiry, dedupe store. |
| **Clock skew** | Prefer server time for validity windows; log both clocks. |
| **Cloud scheduler + offline agent** | Bounded queue, expire stale worker ticks, surface “worker degraded” state. |
| **Legal / regulatory** | Counsel review **before** scaling beyond internal use. |
| **“100% fill guarantee” expectations** | Product education: success = command path + best‑effort execution; broker can still reject. |

**Plan invalidators** (require redesign if central assumptions shift):

- You must support **no local install at all** (violates MT5 integration reality for this approach).
- You need **guaranteed sub‑millisecond** execution (wrong tool chain; needs co‑located low‑latency design).
- You cannot host **any** central infrastructure (peer‑to‑peer trading control is a different threat model and UX).

---

## Appendix: Example command schemas

### A.1 `PlaceMarketOrder`

```json
{
  "command_id": "c9d1f2b8-2c2c-4fd4-b5c6-7b0a6e2c9c11",
  "type": "place_market_order",
  "issued_at": "2026-04-01T12:34:56Z",
  "expires_at": "2026-04-01T12:35:56Z",
  "target": {
    "device_id": "dev_123",
    "account_key": "default"
  },
  "payload": {
    "symbol": "EURUSDm",
    "order_type": "buy",
    "volume": 0.12,
    "comment": "panel:manual",
    "max_slippage_points": 30
  }
}
```

### A.2 `WorkerRun` (cloud-scheduled tick)

```json
{
  "command_id": "b2d3e4f5-3a4b-4c5d-8e9f-0123456789ab",
  "type": "worker_run",
  "issued_at": "2026-04-01T12:40:00Z",
  "expires_at": "2026-04-01T12:41:00Z",
  "target": { "device_id": "dev_123" },
  "payload": {
    "worker": "fixed_lot",
    "params": {
      "account_keys": ["default", "exness"],
      "min_volume": 0.01,
      "max_volume": 0.10,
      "max_open_positions": 5,
      "symbol_pool": ["EURUSDm", "XAUUSDm"],
      "side_mode": "alternate"
    }
  }
}
```

### A.3 Command result (agent → cloud)

```json
{
  "command_id": "c9d1f2b8-2c2c-4fd4-b5c6-7b0a6e2c9c11",
  "status": "success",
  "finished_at": "2026-04-01T12:34:57Z",
  "result": {
    "order_ticket": 123456789,
    "symbol": "EURUSDm",
    "volume": 0.12,
    "order_type": "buy"
  },
  "diagnostics": {
    "agent_version": "1.4.2",
    "mt5_connected": true
  }
}
```

```json
{
  "command_id": "c9d1f2b8-2c2c-4fd4-b5c6-7b0a6e2c9c11",
  "status": "failed",
  "finished_at": "2026-04-01T12:34:57Z",
  "error": {
    "code": "mt5_order_rejected",
    "message": "Invalid volume",
    "mt5_retcode": 10014
  }
}
```

---

## Document control

- **Authoring note:** This document is intentionally implementation-agnostic on exact frameworks so you can choose hosting and stack independently.
- **Review priority:** Sections **Feasibility assurance**, **7–9**, **18–21**, then Appendix schemas.
- **Honesty note:** This plan is **professionally sound**. Final outcomes depend on implementation quality, operations, and external dependencies (MT5/broker/user PCs)—not on wishful “100%” language.

When you are ready for implementation, specify:

- cloud provider
- single-tenant vs multi-tenant
- MVP scope (Phase 1 only vs Phases 1–2)
- whether the first agent must be Python-only on Windows
- expected concurrent devices and regions
