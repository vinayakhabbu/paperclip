// Factory gateway: simulated plant + the two integration surfaces the
// autonomous-factory company needs — (1) fault/shortage events pushed into
// Paperclip's webhook intake (auto-assigned to the Director), (2) a read-only
// HTTP API agents can curl to inspect machines/orders/inventory before acting.
// Swap the simulator internals for real MQTT/OPC-UA/MES adapters later; the
// API shape is the contract that stays.
//
// Usage:
//   node scripts/factory-gateway.mjs                  # run simulator + API
//   node scripts/factory-gateway.mjs --check          # offline self-test
//   node scripts/factory-gateway.mjs install-skill    # upload factory-tools skill + assign to all agents
//
// Env:
//   PAPERCLIP_URL        Paperclip instance (default http://localhost:3100)
//   PAPERCLIP_TOKEN      board API key (required to push events / install skill)
//   COMPANY_ID           target company id (required to push events / install skill)
//   DIRECTOR_AGENT_ID    if set, new fault issues are auto-assigned to it
//   GATEWAY_PUBLIC_URL   URL agents should use to reach this gateway (goes in issue bodies)
//   CONNECTOR_ORDERS_FILE  order export file (.csv or .json) ingested read-only when it changes
//   GATEWAY_UI_TOKEN     if set, every request must carry it (?key= or Authorization: Bearer)
//   FACTORY_DATABASE_URL Postgres for the ontology tables (falls back to DATABASE_URL)
//   FACTORY_STATE_FILE   JSON snapshot path (local alternative to Postgres)
//   PORT                 gateway port (default 8090)
//   TICK_MS              sim tick interval (default 20000)
//   FAULT_PROB           per-machine fault probability per tick (default 0.02)

import http from "node:http";
import assert from "node:assert";
import fs from "node:fs";

const PORT = Number(process.env.PORT ?? 8090);
const TICK_MS = Number(process.env.TICK_MS ?? 20_000);
const FAULT_PROB = Number(process.env.FAULT_PROB ?? 0.02);
const BASE = (process.env.PAPERCLIP_URL ?? "http://localhost:3100").replace(/\/$/, "");
const TOKEN = process.env.PAPERCLIP_TOKEN;
const COMPANY_ID = process.env.COMPANY_ID;
const DIRECTOR_AGENT_ID = process.env.DIRECTOR_AGENT_ID;
const PUBLIC_URL = process.env.GATEWAY_PUBLIC_URL ?? `http://localhost:${PORT}`;
const UI_TOKEN = process.env.GATEWAY_UI_TOKEN;

// Demo switch: random fault/shortage events (each one wakes agents = spends
// tokens) are OFF until started. Manual POST /machines/:id/fault always works.
let autoEvents = process.env.AUTO_EVENTS === "1";

// ── Simulated plant state ────────────────────────────────────────────────────
const FAULTS = {
  cnc: [["E-101", "spindle overtemp"], ["E-104", "tool wear limit"]],
  assembly: [["E-201", "torque out of range"], ["E-203", "part feeder empty"]],
  packaging: [["E-217", "jam sensor"], ["E-220", "film roll misalignment"]],
  amr: [["E-301", "path blocked"], ["E-305", "battery critical"]],
};

// Ontology-lite: products (with BOM), orders, lines, jobs, inventory,
// machines. Relationships are plain foreign keys (order.product → products.id,
// job.orderId/lineId, line.machines). This in-memory shape + the read API
// below IS the v1 operational data layer; swap the storage for Postgres when
// real ERP/MES data starts flowing — the endpoints are the stable contract.
const state = {
  products: [
    { id: "widget-a", name: "Widget A", bom: [{ sku: "ALU-BAR", qtyPer: 1 }, { sku: "FASTENERS", qtyPer: 4 }, { sku: "CARTONS", qtyPer: 1 }] },
    { id: "widget-b", name: "Widget B", bom: [{ sku: "ALU-BAR", qtyPer: 2 }, { sku: "FASTENERS", qtyPer: 6 }, { sku: "CARTONS", qtyPer: 1 }] },
  ],
  lines: [
    { id: "Line A", products: ["widget-a", "widget-b"], ratePerHour: 60, machines: ["CNC-01", "ASM-01", "PKG-02"] },
  ],
  machines: [
    { id: "CNC-01", name: "CNC Mill 1", type: "cnc", line: "Line A", status: "running", faultCode: null, faultSince: null, unitsProduced: 0, consumes: "ALU-BAR" },
    { id: "ASM-01", name: "Assembly Cell 1", type: "assembly", line: "Line A", status: "running", faultCode: null, faultSince: null, unitsProduced: 0, consumes: "FASTENERS" },
    { id: "PKG-02", name: "Packaging Machine 2", type: "packaging", line: "Line A", status: "running", faultCode: null, faultSince: null, unitsProduced: 0, consumes: "CARTONS" },
    { id: "AMR-01", name: "Material Transport AMR", type: "amr", line: "Logistics", status: "running", faultCode: null, faultSince: null, unitsProduced: 0, consumes: null },
  ],
  orders: [
    { id: "SO-1042", product: "widget-a", customer: "OEM North", qty: 500, produced: 180, due: isoIn(1), expedite: false, status: "in_progress", line: "Line A" },
    { id: "SO-1043", product: "widget-a", customer: "OEM North", qty: 300, produced: 40, due: isoIn(1), expedite: false, status: "in_progress", line: "Line A" },
    { id: "SO-1050", product: "widget-b", customer: "Distributor East", qty: 800, produced: 0, due: isoIn(4), expedite: false, status: "queued", line: "Line A" },
  ],
  // Schedule entries. Written by the Production Supervisor (or a solver later)
  // via POST /jobs after validation + approval; the sim treats them as data.
  jobs: [],
  inventory: [
    { sku: "ALU-BAR", name: "Aluminium bar stock", qty: 400, reserved: 0, reorderPoint: 120 },
    { sku: "FASTENERS", name: "Fastener kit", qty: 900, reserved: 0, reorderPoint: 250 },
    { sku: "CARTONS", name: "Shipping cartons", qty: 350, reserved: 0, reorderPoint: 100 },
  ],
  events: [], // ring buffer, newest first
  nextOrderSeq: 2001,
  nextJobSeq: 1,
};

function isoIn(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

// ── Persistence ──────────────────────────────────────────────────────────────
// Two options, both optional:
//  - FACTORY_DATABASE_URL (or DATABASE_URL): Postgres. One plain table per
//    entity (factory_orders, factory_inventory, ...), row per record with a
//    jsonb data column — queryable (`data->>'status'`), durable across
//    redeploys, and the natural home for the solver later. The sim keeps its
//    in-memory working set and syncs the tables ~500ms after each mutation.
//    ponytail: full rewrite of all (~15) entity rows per sync; promote hot
//    fields to real columns + targeted updates when a solver needs indexes.
//  - FACTORY_STATE_FILE: JSON snapshot on disk (local dev convenience).
// Neither set → memory only, resets on restart.
const STATE_FILE = process.env.FACTORY_STATE_FILE;
const DB_URL = process.env.FACTORY_DATABASE_URL ?? process.env.DATABASE_URL;
const ENTITY_TABLES = [
  ["factory_products", "products", "id"],
  ["factory_lines", "lines", "id"],
  ["factory_machines", "machines", "id"],
  ["factory_orders", "orders", "id"],
  ["factory_jobs", "jobs", "id"],
  ["factory_inventory", "inventory", "sku"],
];
let db = null;

async function initDb() {
  if (!DB_URL) return;
  const { createRequire } = await import("node:module");
  // postgres-js is a dep of @paperclipai/db; resolve through that package so
  // the gateway itself stays dependency-free.
  const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
  const postgres = requireFromDb("postgres");
  db = postgres(DB_URL, { max: 2, onnotice: () => {} });

  for (const [table] of ENTITY_TABLES) {
    await db.unsafe(`create table if not exists ${table} (id text primary key, data jsonb not null)`);
  }
  await db.unsafe(`create table if not exists factory_events (seq bigserial primary key, at timestamptz not null default now(), data jsonb not null)`);
  await db.unsafe(`create table if not exists factory_meta (key text primary key, value jsonb not null)`);

  const parseRow = (value) => (typeof value === "string" ? JSON.parse(value) : value);
  const seeded = await db`select value from factory_meta where key = 'seeded'`;
  if (seeded.length > 0) {
    // Restore: DB is the source of truth after first boot. To reseed from the
    // code defaults, drop the factory_* tables and restart.
    for (const [table, key] of ENTITY_TABLES) {
      const rows = await db`select data from ${db(table)}`;
      state[key] = rows.map((row) => parseRow(row.data));
    }
    const meta = await db`select key, value from factory_meta`;
    for (const row of meta) {
      if (row.key === "nextOrderSeq") state.nextOrderSeq = Number(parseRow(row.value));
      if (row.key === "nextJobSeq") state.nextJobSeq = Number(parseRow(row.value));
    }
    const events = await db`select data from factory_events order by seq desc limit 200`;
    state.events = events.map((row) => parseRow(row.data));
    console.log(`ontology restored from Postgres (${state.orders.length} orders, ${state.jobs.length} jobs)`);
  } else {
    await syncDb();
    await db`insert into factory_meta (key, value) values ('seeded', 'true'::jsonb) on conflict (key) do nothing`;
    console.log("ontology seeded into Postgres (factory_* tables)");
  }
}

let syncTimer = null;
function scheduleSync() {
  if (STATE_FILE) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (err) { console.error("state save failed:", err); }
  }
  if (!db || syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncDb().catch((err) => console.error("postgres sync failed:", err));
  }, 500);
}

async function syncDb() {
  if (!db) return;
  await db.begin(async (tx) => {
    for (const [table, key, idField] of ENTITY_TABLES) {
      await tx`delete from ${tx(table)}`;
      for (const row of state[key]) {
        await tx`insert into ${tx(table)} (id, data) values (${String(row[idField])}, ${tx.json(row)})`;
      }
    }
    for (const [key, value] of [["nextOrderSeq", state.nextOrderSeq], ["nextJobSeq", state.nextJobSeq]]) {
      await tx`insert into factory_meta (key, value) values (${key}, ${tx.json(value)}) on conflict (key) do update set value = excluded.value`;
    }
  });
}

function logEvent(kind, message, data = {}) {
  const event = { at: new Date().toISOString(), kind, message, ...data };
  state.events.unshift(event);
  state.events.length = Math.min(state.events.length, 200);
  console.log(`[event] ${kind}: ${message}`);
  if (db) {
    db`insert into factory_events (data) values (${db.json(event)})`
      .catch((err) => console.error("event insert failed:", err));
  }
  scheduleSync();
}

// ── Paperclip push (fault/shortage → issue, auto-assigned to Director) ──────
async function pushIssue({ title, body, priority, sourceRef }, deps = { fetch }) {
  if (!TOKEN || !COMPANY_ID) {
    logEvent("push_skipped", `no PAPERCLIP_TOKEN/COMPANY_ID; not pushing: ${title}`);
    return;
  }
  const headers = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
  const res = await deps.fetch(`${BASE}/api/webhooks/intake/${COMPANY_ID}`, {
    method: "POST", headers, body: JSON.stringify({ title, body, priority, sourceRef }),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status >= 300) {
    logEvent("push_failed", `${res.status} ${JSON.stringify(json)}`);
    return;
  }
  if (json.deduplicated) return;
  logEvent("issue_created", `${json.issue.identifier}: ${title}`, { issueId: json.issue.id });
  if (DIRECTOR_AGENT_ID) {
    await deps.fetch(`${BASE}/api/issues/${json.issue.id}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ assigneeAgentId: DIRECTOR_AGENT_ID, status: "todo" }),
    });
    logEvent("issue_assigned", `${json.issue.identifier} → Director`);
  }
}

// ── Paperclip proxy (customer-facing panels — Paperclip stays backstage) ────
// The control room shows the agents' response and handles approvals through
// these routes. The gateway holds the board token, so the browser never talks
// to (or reveals) the Paperclip instance.
let agentCache = { at: 0, map: {} };

async function pc(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (res.status >= 300) throw new Error(`paperclip ${res.status}: ${JSON.stringify(out)}`);
  return out;
}

async function agentNames() {
  if (Date.now() - agentCache.at > 60_000) {
    const out = await pc("GET", `/companies/${COMPANY_ID}/agents`);
    agentCache = { at: Date.now(), map: Object.fromEntries((out.agents ?? out).map((a) => [a.id, a.name])) };
  }
  return agentCache.map;
}

// One chronological feed of the whole task tree: task creations + comments.
// ponytail: N+1 comment fetches per refresh; fine for demo-sized trees.
async function responseLog(issueId) {
  const [tree, names] = await Promise.all([
    pc("GET", `/companies/${COMPANY_ID}/issues?descendantOf=${encodeURIComponent(issueId)}`),
    agentNames(),
  ]);
  const entries = [];
  for (const issue of tree) {
    entries.push({ at: issue.createdAt, task: issue.identifier ?? issue.id.slice(0, 8), kind: "created", author: null, body: issue.title, status: issue.status });
    for (const comment of await pc("GET", `/issues/${issue.id}/comments?order=asc`)) {
      if (comment.deletedAt) continue;
      const agentId = comment.authorAgentId ?? comment.derivedAuthorAgentId;
      entries.push({
        at: comment.createdAt,
        task: issue.identifier ?? issue.id.slice(0, 8),
        kind: "comment",
        author: agentId ? (names[agentId] ?? "Agent") : comment.authorUserId ? "Board" : "System",
        body: comment.body,
      });
    }
  }
  return entries.sort((a, b) => new Date(a.at) - new Date(b.at));
}

function machineSnapshot(machine) {
  const orders = state.orders.filter((o) => o.line === machine.line && o.status === "in_progress");
  return JSON.stringify({ machine, affectedOrders: orders }, null, 2);
}

function raiseFault(machine, code, label, deps) {
  machine.status = "fault";
  machine.faultCode = code;
  machine.faultSince = new Date().toISOString();
  const incident = `${machine.id}/${code}/${Date.now()}`;
  logEvent("fault", `${machine.id} fault ${code} (${label})`, { machineId: machine.id, code });
  return pushIssue({
    title: `[${machine.id}] Fault ${code} — ${label} (${machine.line})`,
    priority: "critical",
    sourceRef: `sim://${incident}`,
    body: [
      `Machine fault detected by factory gateway.`,
      ``,
      `Current state snapshot:`,
      "```json", machineSnapshot(machine), "```",
      ``,
      `Live state API (query before diagnosing): ${PUBLIC_URL}`,
      `- GET ${PUBLIC_URL}/machines/${machine.id}`,
      `- GET ${PUBLIC_URL}/orders`,
      `- POST ${PUBLIC_URL}/machines/${machine.id}/repair  (only after an approved work order)`,
      ``,
      `Diagnose likely cause, assess production impact, propose a recovery plan.`,
      `High-impact actions need approval per governance.`,
    ].join("\n"),
  }, deps);
}

// ── Order intake (the "customer/OEM broadcast" entry point) ─────────────────
// Expedited orders become a hot-job Paperclip task assigned to the Director.
// This is the demand-intake integration service — deliberately not an agent.
async function createOrder({ product, qty, due, customer, expedite }, deps = { fetch }) {
  const productRow = state.products.find((p) => p.id === product);
  if (!productRow) throw new Error(`unknown product "${product}" (see /products)`);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("qty must be a positive number");
  if (!due) throw new Error("due date required (YYYY-MM-DD)");

  const order = {
    id: `SO-${state.nextOrderSeq++}`,
    product,
    customer: customer ?? "Unknown customer",
    qty,
    produced: 0,
    due,
    expedite: Boolean(expedite),
    status: "queued",
    line: null,
  };
  state.orders.push(order);
  logEvent("order_received", `${order.id}: ${qty}x ${productRow.name} due ${due}${order.expedite ? " (EXPEDITED)" : ""}`, { orderId: order.id });

  if (order.expedite) await pushHotJob(order, productRow, deps);
  return order;
}

async function pushHotJob(order, productRow, deps = { fetch }) {
  await pushIssue({
    title: `[HOT JOB] Expedited order ${order.id} — ${order.qty}x ${productRow.name} due ${order.due}`,
    priority: "critical",
    sourceRef: `sim://order/${order.id}/expedite`,
    body: [
        `Expedited customer order received by the factory gateway. Insert it into the current schedule without breaking existing commitments.`,
        ``,
        `Order: ${JSON.stringify(order)}`,
        `BOM: ${JSON.stringify(productRow.bom)}`,
        ``,
        `Validate before scheduling (query live state, quote evidence):`,
        `- GET ${PUBLIC_URL}/orders — current order book and progress`,
        `- GET ${PUBLIC_URL}/products — BOM for ${productRow.name}`,
        `- GET ${PUBLIC_URL}/inventory — material availability vs reservations`,
        `- GET ${PUBLIC_URL}/lines — line capability and rate`,
        `- GET ${PUBLIC_URL}/machines — line health right now`,
        `- GET ${PUBLIC_URL}/jobs — already-planned schedule entries`,
        ``,
        `Compute the schedule (NEVER invent start/end times yourself):`,
        `- POST ${PUBLIC_URL}/schedule/solve — deterministic plan + conflicts; quote its output as evidence`,
        ``,
        `Bounded writes (only after validation and required approvals):`,
        `- POST ${PUBLIC_URL}/inventory/:sku/reserve {"qty": n, "orderId": "${order.id}"}`,
        `- POST ${PUBLIC_URL}/jobs — use plannedStart/plannedEnd from the solver output verbatim`,
        ``,
      `Schedule changes affecting existing due-date commitments need board approval per governance.`,
    ].join("\n"),
  }, deps);
}

// ── Connector #1: orders (Phase A, read-only) ────────────────────────────────
// First real-system seam. Point CONNECTOR_ORDERS_FILE at an ERP/MES order
// export (.json array, or .csv with headers id,product,qty,due,customer,expedite);
// the gateway re-reads it whenever it changes and upserts orders by id. The
// file is never written back — read-only, exactly Phase A. A future REST/MQTT
// connector calls ingestOrders() with the same row shape; nothing else changes.
const ORDERS_FILE = process.env.CONNECTOR_ORDERS_FILE;
let ordersFileMtime = 0;

function parseCsv(text) {
  // ponytail: naive CSV (no quoted commas) — fine for exports of this shape;
  // swap for a real parser if fields ever contain commas.
  const [header, ...rows] = text.trim().split(/\r?\n/);
  const cols = header.split(",").map((s) => s.trim());
  return rows.filter(Boolean).map((row) => {
    const cells = row.split(",").map((s) => s.trim());
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  });
}

async function ingestOrders(rows, deps = { fetch }) {
  let added = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    const productRow = state.products.find((p) => p.id === row.product);
    const qty = Number(row.qty);
    const expedite = row.expedite === true || ["true", "1", "yes"].includes(String(row.expedite).toLowerCase());
    if (!row.id || !productRow || !Number.isFinite(qty) || qty <= 0 || !row.due) {
      skipped++;
      continue;
    }
    const existing = state.orders.find((o) => o.id === row.id);
    if (existing) {
      const wasExpedite = existing.expedite;
      Object.assign(existing, { qty, due: row.due, expedite, customer: row.customer ?? existing.customer });
      updated++;
      // Flipped to expedited upstream → hot job (sourceRef dedups re-pushes).
      if (expedite && !wasExpedite) await pushHotJob(existing, productRow, deps);
    } else {
      const order = {
        id: row.id, product: row.product, customer: row.customer ?? "Unknown customer",
        qty, produced: 0, due: row.due, expedite, status: "queued", line: null,
      };
      state.orders.push(order);
      added++;
      logEvent("order_received", `${order.id}: ${qty}x ${productRow.name} due ${order.due}${expedite ? " (EXPEDITED)" : ""} [connector]`, { orderId: order.id });
      if (expedite) await pushHotJob(order, productRow, deps);
    }
  }
  return { added, updated, skipped };
}

async function pollOrdersFile(deps = { fetch }) {
  if (!ORDERS_FILE) return;
  let mtime;
  try { mtime = fs.statSync(ORDERS_FILE).mtimeMs; } catch { return; } // absent file = connector idle
  if (mtime === ordersFileMtime) return;
  ordersFileMtime = mtime;
  try {
    const text = fs.readFileSync(ORDERS_FILE, "utf8");
    const rows = ORDERS_FILE.endsWith(".json") ? JSON.parse(text) : parseCsv(text);
    const { added, updated, skipped } = await ingestOrders(rows, deps);
    logEvent("connector", `orders connector: ${added} new, ${updated} updated${skipped ? `, ${skipped} skipped` : ""}`);
  } catch (err) {
    logEvent("connector_error", `orders connector failed: ${err.message ?? err}`);
  }
}

// ── Deterministic scheduler ──────────────────────────────────────────────────
// The LLM never invents a schedule. Agents call POST /schedule/solve; the
// gateway computes the plan deterministically; the agent explains it and —
// after approval — commits it via POST /jobs using the solver's times
// verbatim. Greedy list scheduling: expedite first, then earliest due date;
// each order goes to the capable line that finishes it soonest, at the line's
// effective rate (nominal rate scaled by fraction of running machines).
// ponytail: greedy EDF, no preemption/changeovers/shifts; swap in OR-Tools
// CP-SAT behind this same endpoint when constraints outgrow it.
function solveSchedule(now = new Date()) {
  const conflicts = [];
  const open = state.orders
    .filter((o) => o.status !== "done" && o.produced < o.qty)
    .sort((a, b) =>
      (Number(b.expedite) - Number(a.expedite)) || a.due.localeCompare(b.due) || a.id.localeCompare(b.id));

  const lineInfo = state.lines.map((line) => {
    const machines = state.machines.filter((m) => line.machines.includes(m.id));
    const running = machines.filter((m) => m.status === "running").length;
    const rate = machines.length ? (line.ratePerHour * running) / machines.length : 0;
    return { line, rate, cursor: now.getTime() };
  });

  // Material feasibility in plan order: each order draws down projected stock.
  const stock = Object.fromEntries(state.inventory.map((i) => [i.sku, i.qty - i.reserved]));

  const plan = [];
  for (const order of open) {
    const remaining = order.qty - order.produced;
    const capable = lineInfo.filter((li) => li.line.products.includes(order.product) && li.rate > 0);
    if (capable.length === 0) {
      conflicts.push({ type: "no_capable_line", orderId: order.id, product: order.product });
      continue;
    }
    for (const { sku, qtyPer } of state.products.find((p) => p.id === order.product)?.bom ?? []) {
      const need = remaining * qtyPer;
      if ((stock[sku] ?? 0) < need) {
        conflicts.push({ type: "material_short", orderId: order.id, sku, need, available: Math.max(0, stock[sku] ?? 0) });
      }
      stock[sku] = (stock[sku] ?? 0) - need;
    }
    const best = capable.reduce((a, b) =>
      (b.cursor + (remaining / b.rate) * 3_600_000 < a.cursor + (remaining / a.rate) * 3_600_000 ? b : a));
    const start = new Date(best.cursor);
    const end = new Date(best.cursor + (remaining / best.rate) * 3_600_000);
    best.cursor = end.getTime();
    if (end.toISOString().slice(0, 10) > order.due) {
      conflicts.push({ type: "late", orderId: order.id, due: order.due, plannedEnd: end.toISOString() });
    }
    plan.push({
      orderId: order.id,
      lineId: best.line.id,
      qty: remaining,
      plannedStart: start.toISOString(),
      plannedEnd: end.toISOString(),
      rationale: `${remaining} units @ ${best.rate}/h on ${best.line.id} (expedite=${order.expedite}, due ${order.due})`,
    });
  }
  return {
    solvedAt: now.toISOString(),
    method: "greedy-edf",
    plan,
    conflicts,
    existingPlannedJobs: state.jobs.filter((j) => j.status === "planned").map((j) => j.id),
  };
}

// ── Sim tick ─────────────────────────────────────────────────────────────────
async function tick(deps = { fetch, random: Math.random }) {
  await pollOrdersFile(deps);
  for (const machine of state.machines) {
    if (machine.status !== "running") continue;

    // Produce + consume material
    machine.unitsProduced += 5;
    const order = state.orders.find((o) => o.line === machine.line && o.status === "in_progress");
    if (order) {
      order.produced = Math.min(order.qty, order.produced + 5);
      if (order.produced >= order.qty) {
        order.status = "done";
        logEvent("order_done", `${order.id} completed`);
        const next = state.orders.find((o) => o.line === machine.line && o.status === "queued");
        if (next) next.status = "in_progress";
      }
    }
    if (machine.consumes) {
      const item = state.inventory.find((i) => i.sku === machine.consumes);
      if (item) {
        item.qty = Math.max(0, item.qty - 3);
        if (autoEvents && item.qty > 0 && item.qty <= item.reorderPoint && !item.shortageRaised) {
          item.shortageRaised = true;
          logEvent("shortage", `${item.sku} at/below reorder point (${item.qty})`);
          await pushIssue({
            title: `[INVENTORY] ${item.sku} below reorder point (${item.qty} left)`,
            priority: "high",
            sourceRef: `sim://inventory/${item.sku}/${Date.now()}`,
            body: `${item.name} is at ${item.qty} units (reorder point ${item.reorderPoint}). Consuming machine: ${machine.id}. Assess supply risk and propose replenishment.\n\nLive state: GET ${PUBLIC_URL}/inventory`,
          }, deps);
        }
        if (item.qty === 0 && machine.status === "running") {
          machine.status = "idle";
          logEvent("starved", `${machine.id} idle — ${item.sku} exhausted`, { machineId: machine.id });
        }
      }
    }

    // Random fault (only while the demo switch is on)
    if (autoEvents && deps.random() < FAULT_PROB) {
      const table = FAULTS[machine.type] ?? [["E-000", "unknown fault"]];
      const [code, label] = table[Math.floor(deps.random() * table.length)];
      await raiseFault(machine, code, label, deps);
    }
  }
  // Production counters mutate without emitting events; persist them too.
  scheduleSync();
}

// ── Read/act API ─────────────────────────────────────────────────────────────
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function serve() {
  await initDb();
  await pollOrdersFile();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://x`);
    const parts = url.pathname.split("/").filter(Boolean);
    // Shared-secret gate for internet-facing deploys. The control room carries
    // the key from its own URL (?key=) on every fetch, so an iframe embed just
    // needs the key once in its src. Unset = open (local dev).
    if (UI_TOKEN) {
      const authed = url.searchParams.get("key") === UI_TOKEN ||
        req.headers.authorization === `Bearer ${UI_TOKEN}`;
      if (!authed) return json(res, 401, { error: "unauthorized: pass ?key= or Authorization: Bearer <GATEWAY_UI_TOKEN>" });
    }
    try {
      if (req.method === "GET" && parts.length === 0) {
        return json(res, 200, {
          service: "factory-gateway",
          autoEvents,
          endpoints: [
            "GET /ui  (human control room)",
            "GET /machines", "GET /machines/:id", "GET /orders", "GET /orders/:id",
            "GET /products", "GET /lines", "GET /jobs", "GET /inventory", "GET /events",
            "POST /orders {product, qty, due, customer?, expedite?}",
            "POST /schedule/solve  (deterministic plan proposal — read-only)",
            "POST /jobs {orderId, lineId, plannedStart, plannedEnd, note?}",
            "POST /inventory/:sku/reserve {qty, orderId?}",
            "POST /machines/:id/repair", "POST /machines/:id/fault",
            "POST /sim/start", "POST /sim/stop",
            "GET /response/incidents", "GET /response/log/:issueId",
            "GET /approvals", "POST /approvals/:id/approve|reject",
          ],
        });
      }
      if (req.method === "POST" && parts[0] === "sim" && (parts[1] === "start" || parts[1] === "stop")) {
        autoEvents = parts[1] === "start";
        logEvent("sim", `auto events ${autoEvents ? "started" : "stopped"}`);
        return json(res, 200, { autoEvents });
      }
      if (req.method === "GET" && parts[0] === "ui") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(fs.readFileSync(new URL("./factory-control-room.html", import.meta.url)));
      }
      if (req.method === "GET" && parts[0] === "machines" && !parts[1]) return json(res, 200, state.machines);
      if (req.method === "GET" && parts[0] === "machines" && parts[1]) {
        const machine = state.machines.find((m) => m.id === parts[1]);
        return machine ? json(res, 200, machine) : json(res, 404, { error: "machine not found" });
      }
      if (req.method === "GET" && parts[0] === "orders" && parts[1]) {
        const order = state.orders.find((o) => o.id === parts[1]);
        return order ? json(res, 200, order) : json(res, 404, { error: "order not found" });
      }
      if (req.method === "GET" && parts[0] === "orders") return json(res, 200, state.orders);
      if (req.method === "GET" && parts[0] === "products") return json(res, 200, state.products);
      if (req.method === "GET" && parts[0] === "lines") return json(res, 200, state.lines);
      if (req.method === "GET" && parts[0] === "jobs") return json(res, 200, state.jobs);
      if (req.method === "GET" && parts[0] === "inventory") return json(res, 200, state.inventory);
      if (req.method === "GET" && parts[0] === "events") return json(res, 200, state.events.slice(0, 50));

      if (parts[0] === "response" && req.method === "GET") {
        if (!TOKEN || !COMPANY_ID) return json(res, 200, { configured: false, incidents: [], entries: [] });
        if (parts[1] === "incidents") {
          const incidents = state.events
            .filter((e) => e.kind === "issue_created" && e.issueId)
            .map((e) => ({ issueId: e.issueId, at: e.at, title: e.message }));
          return json(res, 200, { configured: true, incidents });
        }
        if (parts[1] === "log" && parts[2]) {
          return json(res, 200, { configured: true, entries: await responseLog(parts[2]) });
        }
      }
      if (parts[0] === "approvals") {
        if (!TOKEN || !COMPANY_ID) return json(res, 200, { configured: false, approvals: [] });
        if (req.method === "GET" && !parts[1]) {
          const [approvals, names] = await Promise.all([
            pc("GET", `/companies/${COMPANY_ID}/approvals?status=pending`),
            agentNames(),
          ]);
          return json(res, 200, {
            configured: true,
            approvals: approvals.map((a) => ({
              id: a.id, type: a.type, at: a.createdAt, payload: a.payload,
              requestedBy: a.requestedByAgentId ? (names[a.requestedByAgentId] ?? "Agent") : "Board",
            })),
          });
        }
        if (req.method === "POST" && parts[1] && (parts[2] === "approve" || parts[2] === "reject")) {
          const body = await readBody(req).catch(() => ({}));
          const out = await pc("POST", `/approvals/${parts[1]}/${parts[2]}`, {
            decisionNote: body.note ?? `${parts[2]}d via NomosAgents control room`,
          });
          logEvent("approval", `approval ${parts[1].slice(0, 8)}… ${parts[2]}d from control room`);
          return json(res, 200, out);
        }
      }
      if (req.method === "POST" && parts[0] === "schedule" && parts[1] === "solve") {
        return json(res, 200, solveSchedule());
      }
      if (req.method === "POST" && parts[0] === "orders") {
        try {
          const order = await createOrder(await readBody(req));
          return json(res, 201, order);
        } catch (err) {
          return json(res, 422, { error: String(err.message ?? err) });
        }
      }
      if (req.method === "POST" && parts[0] === "jobs") {
        const body = await readBody(req).catch(() => null);
        if (!body) return json(res, 422, { error: "body must be valid JSON" });
        const order = state.orders.find((o) => o.id === body.orderId);
        const line = state.lines.find((l) => l.id === body.lineId);
        if (!order) return json(res, 422, { error: `unknown orderId "${body.orderId}"` });
        if (!line) return json(res, 422, { error: `unknown lineId "${body.lineId}" (see /lines)` });
        if (!line.products.includes(order.product)) {
          return json(res, 422, { error: `line ${line.id} cannot produce ${order.product}` });
        }
        const job = {
          id: `JOB-${state.nextJobSeq++}`,
          orderId: order.id,
          lineId: line.id,
          plannedStart: body.plannedStart ?? null,
          plannedEnd: body.plannedEnd ?? null,
          note: body.note ?? null,
          status: "planned",
          createdAt: new Date().toISOString(),
        };
        state.jobs.push(job);
        logEvent("job_planned", `${job.id}: ${order.id} on ${line.id} (${job.plannedStart ?? "unscheduled"} → ${job.plannedEnd ?? "?"})`, { jobId: job.id, orderId: order.id });
        return json(res, 201, job);
      }
      if (req.method === "POST" && parts[0] === "inventory" && parts[2] === "reserve") {
        const item = state.inventory.find((i) => i.sku === parts[1]);
        if (!item) return json(res, 404, { error: "sku not found" });
        const body = await readBody(req).catch(() => null);
        const qty = Number(body?.qty);
        if (!Number.isFinite(qty) || qty <= 0) return json(res, 422, { error: "qty must be a positive number" });
        const available = item.qty - item.reserved;
        if (qty > available) {
          return json(res, 422, { error: `insufficient stock: ${available} available (${item.qty} on hand − ${item.reserved} reserved)` });
        }
        item.reserved += qty;
        logEvent("inventory_reserved", `${qty}x ${item.sku} reserved${body?.orderId ? ` for ${body.orderId}` : ""}`, { sku: item.sku, qty });
        return json(res, 200, item);
      }

      if (req.method === "POST" && parts[0] === "machines" && parts[2] === "repair") {
        const machine = state.machines.find((m) => m.id === parts[1]);
        if (!machine) return json(res, 404, { error: "machine not found" });
        machine.status = "running";
        const cleared = machine.faultCode;
        machine.faultCode = null;
        machine.faultSince = null;
        logEvent("repair", `${machine.id} repaired (cleared ${cleared ?? "none"})`, { machineId: machine.id });
        return json(res, 200, machine);
      }
      if (req.method === "POST" && parts[0] === "machines" && parts[2] === "fault") {
        // Manual fault injection for demos
        const machine = state.machines.find((m) => m.id === parts[1]);
        if (!machine) return json(res, 404, { error: "machine not found" });
        const table = FAULTS[machine.type] ?? [["E-000", "unknown fault"]];
        const [code, label] = table[0];
        await raiseFault(machine, code, label, { fetch });
        return json(res, 200, machine);
      }
      return json(res, 404, { error: "not found" });
    } catch (err) {
      return json(res, 500, { error: String(err) });
    }
  });
  server.listen(PORT, () => {
    console.log(`factory-gateway listening on :${PORT} (tick ${TICK_MS}ms, fault prob ${FAULT_PROB}, auto events ${autoEvents ? "ON" : "OFF — POST /sim/start to begin demo"})`);
    console.log(`pushing events to ${TOKEN && COMPANY_ID ? `${BASE} company ${COMPANY_ID}` : "(disabled — set PAPERCLIP_TOKEN + COMPANY_ID)"}`);
    console.log(`ontology storage: ${db ? "Postgres (factory_* tables)" : STATE_FILE ? `JSON snapshot ${STATE_FILE}` : "memory only (set FACTORY_DATABASE_URL for Postgres)"}`);
    console.log(`control room: ${PUBLIC_URL}/ui${UI_TOKEN ? "?key=<GATEWAY_UI_TOKEN> (auth required)" : " (open — set GATEWAY_UI_TOKEN before exposing to the internet)"}`);
    if (ORDERS_FILE) console.log(`orders connector: watching ${ORDERS_FILE} (read-only)`);
  });
  setInterval(() => void tick().catch((err) => console.error("tick failed:", err)), TICK_MS);
}

// ── install-skill: upload factory-tools SKILL.md + assign to every agent ────
async function installSkill() {
  if (!TOKEN || !COMPANY_ID) {
    console.error("Set PAPERCLIP_TOKEN and COMPANY_ID");
    process.exit(1);
  }
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const markdown = fs.readFileSync(path.join(here, "factory-tools.skill.md"), "utf8")
    .replaceAll("__GATEWAY_URL__", PUBLIC_URL);
  const headers = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
  const api = async (method, url, body) => {
    const res = await fetch(`${BASE}/api${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const out = await res.json().catch(() => ({}));
    if (res.status >= 300) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(out)}`);
    return out;
  };

  await api("POST", `/companies/${COMPANY_ID}/skills`, {
    name: "Factory Tools", slug: "factory-tools", markdown, overwrite: true,
  });
  console.log("skill factory-tools uploaded");

  const agents = await api("GET", `/companies/${COMPANY_ID}/agents`);
  for (const agent of agents.agents ?? agents) {
    const snapshot = await api("GET", `/agents/${agent.id}/skills?companyId=${COMPANY_ID}`);
    const entries = snapshot.desiredSkillEntries ?? (snapshot.desiredSkills ?? []).map((key) => ({ key, versionId: null }));
    if (entries.some((entry) => entry.key.includes("factory-tools"))) {
      console.log(`agent ${agent.name}: already assigned`);
      continue;
    }
    await api("PATCH", `/agents/${agent.id}?companyId=${COMPANY_ID}`, {
      desiredSkills: [...entries, "factory-tools"],
    });
    console.log(`agent ${agent.name}: factory-tools assigned`);
  }
  console.log("done");
}

// ── Offline self-check ───────────────────────────────────────────────────────
async function check() {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    return { status: 201, json: async () => ({ issue: { id: "i1", identifier: "AUT-9" }, deduplicated: false }) };
  };
  const pkg = state.machines.find((m) => m.id === "PKG-02");
  await raiseFault(pkg, "E-217", "jam sensor", { fetch: fakeFetch });
  assert.equal(pkg.status, "fault");
  assert.equal(pkg.faultCode, "E-217");
  if (TOKEN && COMPANY_ID) {
    assert.ok(calls[0].body.title.includes("PKG-02"));
    assert.ok(calls[0].body.sourceRef.startsWith("sim://PKG-02/E-217"));
  }
  // deterministic tick: no random faults, production advances
  const so = state.orders.find((o) => o.id === "SO-1042");
  const before = so.produced;
  await tick({ fetch: fakeFetch, random: () => 1 });
  assert.ok(so.produced > before); // CNC/ASM still running on Line A advance it
  // repair path
  pkg.status = "running"; pkg.faultCode = null;
  assert.equal(pkg.status, "running");
  // expedited order intake → hot-job push with ontology pointers
  calls.length = 0;
  const order = await createOrder(
    { product: "widget-b", qty: 120, due: "2026-08-01", customer: "OEM South", expedite: true },
    { fetch: fakeFetch },
  );
  assert.ok(order.id.startsWith("SO-"));
  assert.equal(state.orders.at(-1).id, order.id);
  if (TOKEN && COMPANY_ID) {
    assert.ok(calls[0].body.title.includes(order.id));
    assert.ok(calls[0].body.body.includes("/inventory"));
  }
  await assert.rejects(() => createOrder({ product: "nope", qty: 1, due: "2026-08-01" }, { fetch: fakeFetch }));
  // reservation math
  const cartons = state.inventory.find((i) => i.sku === "CARTONS");
  cartons.reserved = cartons.qty - 5;
  assert.ok(cartons.qty - cartons.reserved === 5);
  // solver: deterministic, expedite-first, pure (no state mutation), flags shortages
  const fixed = new Date("2026-07-13T00:00:00Z");
  const snapshot = JSON.stringify(state);
  const s1 = solveSchedule(fixed);
  const s2 = solveSchedule(fixed);
  assert.deepEqual(s1, s2);
  assert.equal(JSON.stringify(state), snapshot);
  assert.equal(s1.plan[0].orderId, order.id); // expedited order jumps the queue
  assert.ok(s1.plan.every((j) => j.plannedStart && j.plannedEnd && j.lineId));
  assert.ok(s1.conflicts.some((c) => c.type === "material_short" && c.sku === "CARTONS")); // only 5 available
  // connector: CSV parse + read-only upsert ingest
  const csvRows = parseCsv("id,product,qty,due,customer,expedite\r\nSO-9001,widget-a,50,2026-08-05,Connector Co,true\n");
  assert.deepEqual(csvRows, [{ id: "SO-9001", product: "widget-a", qty: "50", due: "2026-08-05", customer: "Connector Co", expedite: "true" }]);
  calls.length = 0;
  let ingest = await ingestOrders(csvRows, { fetch: fakeFetch });
  assert.deepEqual(ingest, { added: 1, updated: 0, skipped: 0 });
  assert.ok(state.orders.some((o) => o.id === "SO-9001" && o.expedite));
  if (TOKEN && COMPANY_ID) assert.ok(calls[0].body.title.includes("SO-9001"));
  ingest = await ingestOrders(csvRows, { fetch: fakeFetch }); // idempotent re-read
  assert.deepEqual(ingest, { added: 0, updated: 1, skipped: 0 });
  assert.equal(state.orders.filter((o) => o.id === "SO-9001").length, 1);
  ingest = await ingestOrders([{ id: "SO-9002", product: "nope", qty: "5", due: "2026-08-05" }], { fetch: fakeFetch });
  assert.deepEqual(ingest, { added: 0, updated: 0, skipped: 1 });
  // response-log merge: tree + comments interleaved chronologically
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    status: 200,
    json: async () => {
      if (url.includes("/agents")) return [{ id: "ag1", name: "Director" }];
      if (url.includes("descendantOf")) {
        return [
          { id: "i1", identifier: "AUT-1", title: "Fault", createdAt: "2026-07-19T10:00:00Z", status: "in_progress" },
          { id: "i2", identifier: "AUT-2", title: "Diagnose", createdAt: "2026-07-19T10:05:00Z", status: "todo" },
        ];
      }
      if (url.includes("/issues/i1/comments")) return [{ id: "c1", authorAgentId: "ag1", body: "delegating", createdAt: "2026-07-19T10:06:00Z" }];
      return [];
    },
  });
  try {
    const log = await responseLog("i1");
    assert.deepEqual(log.map((e) => [e.kind, e.task, e.author]), [
      ["created", "AUT-1", null], ["created", "AUT-2", null], ["comment", "AUT-1", "Director"],
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log("self-check ok");
}

const mode = process.argv[2];
if (mode === "--check") await check();
else if (mode === "install-skill") await installSkill();
else await serve();
