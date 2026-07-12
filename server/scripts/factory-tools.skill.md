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
| Orders with progress and due dates | `curl -s __GATEWAY_URL__/orders` |
| Inventory levels vs reorder points | `curl -s __GATEWAY_URL__/inventory` |
| Recent factory event log (newest first) | `curl -s __GATEWAY_URL__/events` |
| Mark a machine repaired | `curl -s -X POST __GATEWAY_URL__/machines/PKG-02/repair` |

## Rules

1. **Read before you reason.** Fetch the machine, its line's orders, and recent events before writing any diagnosis or impact assessment. Quote actual values (fault code, units produced, qty remaining, due dates) in your comments.
2. **Repair is a protected action.** Only POST `/machines/:id/repair` after the repair work order has been completed and, where required by governance, approved. Never call it to "test".
3. **No other writes exist.** You cannot change schedules, setpoints, or inventory through the gateway. Propose such actions as recommendations in the issue and request approval.
4. **Cite evidence.** When you use gateway data in a decision, paste the relevant JSON fragment into your issue comment so the audit trail shows what you saw.

## Example

For a fault on PKG-02:

```bash
curl -s __GATEWAY_URL__/machines/PKG-02     # confirm fault code and since-when
curl -s __GATEWAY_URL__/orders              # which orders are at risk
curl -s __GATEWAY_URL__/events              # what happened around the fault
```

Then comment your diagnosis with the evidence, delegate or execute per your role, and only after the repair is done and verified: `POST /machines/PKG-02/repair`, then re-GET the machine to confirm `"status": "running"`.
