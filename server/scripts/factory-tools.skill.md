---
name: factory-tools
description: >
  Query live factory state (machines, orders, inventory, event log) from the factory gateway before diagnosing or proposing actions, and record repairs after an approved work order.
---

# Factory Tools

## Use when

You are working on any factory incident, shortage, scheduling, energy, or reporting task. Always read live state from the gateway before diagnosing, estimating impact, or proposing actions — never reason from the issue text alone.

## Gateway

Base URL: `__GATEWAY_URL__` (a fault issue's body may also state the URL; prefer the issue's URL if they differ).

All reads are plain HTTP GET returning JSON. Use curl.

## Endpoints

| Purpose | Call |
|---|---|
| List all machines with status/fault codes | `curl -s __GATEWAY_URL__/machines` |
| One machine's live state | `curl -s __GATEWAY_URL__/machines/PKG-02` |
| Orders with progress, due dates, expedite flags | `curl -s __GATEWAY_URL__/orders` (or `/orders/SO-1042`) |
| Products and their BOM | `curl -s __GATEWAY_URL__/products` |
| Production lines: capability, rate, machines | `curl -s __GATEWAY_URL__/lines` |
| Planned schedule entries (jobs) | `curl -s __GATEWAY_URL__/jobs` |
| Inventory: on hand, reserved, reorder points | `curl -s __GATEWAY_URL__/inventory` |
| Recent factory event log (newest first) | `curl -s __GATEWAY_URL__/events` |
| Compute a schedule proposal (deterministic, read-only) | `curl -s -X POST __GATEWAY_URL__/schedule/solve` |
| Mark a machine repaired | `curl -s -X POST __GATEWAY_URL__/machines/PKG-02/repair` |
| Reserve material for an order | `curl -s -X POST __GATEWAY_URL__/inventory/CARTONS/reserve -d '{"qty":120,"orderId":"SO-2001"}'` |
| Add a planned schedule entry | `curl -s -X POST __GATEWAY_URL__/jobs -d '{"orderId":"SO-2001","lineId":"Line A","plannedStart":"2026-08-01T06:00:00Z","plannedEnd":"2026-08-01T14:00:00Z","note":"hot job insertion"}'` |

## Rules

1. **Read before you reason.** Fetch the machine, its line's orders, and recent events before writing any diagnosis or impact assessment. Quote actual values (fault code, units produced, qty remaining, due dates) in your comments.
2. **Writes are protected actions.** Only POST `/machines/:id/repair`, `/inventory/:sku/reserve`, or `/jobs` after the corresponding work is validated and, where required by governance, approved. Never call them to "test". Reserving material and planning jobs for a hot job that displaces existing due-date commitments needs board approval first.
3. **Available stock = `qty − reserved`.** Never reserve more than available; if stock is insufficient, raise it as a finding, don't force it.
4. **Schedules come from the solver, never from you.** Do not invent `plannedStart`/`plannedEnd`. Run `POST /schedule/solve`, quote its `plan` and `conflicts` in the issue as evidence, resolve conflicts (reserve material, escalate lateness, repair lines), and — after required approvals — `POST /jobs` using the solver's times **verbatim**. Your job is to prepare the input and explain the output, not to compute the schedule.
5. **Cite evidence.** When you use gateway data in a decision, paste the relevant JSON fragment into your issue comment so the audit trail shows what you saw.

## Example

For a fault on PKG-02:

```bash
curl -s __GATEWAY_URL__/machines/PKG-02     # confirm fault code and since-when
curl -s __GATEWAY_URL__/orders              # which orders are at risk
curl -s __GATEWAY_URL__/events              # what happened around the fault
```

Then comment your diagnosis with the evidence, delegate or execute per your role, and only after the repair is done and verified: `POST /machines/PKG-02/repair`, then re-GET the machine to confirm `"status": "running"`.
