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
//   PORT                 gateway port (default 8090)
//   TICK_MS              sim tick interval (default 20000)
//   FAULT_PROB           per-machine fault probability per tick (default 0.02)

import http from "node:http";
import assert from "node:assert";

const PORT = Number(process.env.PORT ?? 8090);
const TICK_MS = Number(process.env.TICK_MS ?? 20_000);
const FAULT_PROB = Number(process.env.FAULT_PROB ?? 0.02);
const BASE = (process.env.PAPERCLIP_URL ?? "http://localhost:3100").replace(/\/$/, "");
const TOKEN = process.env.PAPERCLIP_TOKEN;
const COMPANY_ID = process.env.COMPANY_ID;
const DIRECTOR_AGENT_ID = process.env.DIRECTOR_AGENT_ID;
const PUBLIC_URL = process.env.GATEWAY_PUBLIC_URL ?? `http://localhost:${PORT}`;

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

const state = {
  machines: [
    { id: "CNC-01", name: "CNC Mill 1", type: "cnc", line: "Line A", status: "running", faultCode: null, faultSince: null, unitsProduced: 0, consumes: "ALU-BAR" },
    { id: "ASM-01", name: "Assembly Cell 1", type: "assembly", line: "Line A", status: "running", faultCode: null, faultSince: null, unitsProduced: 0, consumes: "FASTENERS" },
    { id: "PKG-02", name: "Packaging Machine 2", type: "packaging", line: "Line A", status: "running", faultCode: null, faultSince: null, unitsProduced: 0, consumes: "CARTONS" },
    { id: "AMR-01", name: "Material Transport AMR", type: "amr", line: "Logistics", status: "running", faultCode: null, faultSince: null, unitsProduced: 0, consumes: null },
  ],
  orders: [
    { id: "SO-1042", product: "Widget A", qty: 500, produced: 180, due: isoIn(1), status: "in_progress", line: "Line A" },
    { id: "SO-1043", product: "Widget A", qty: 300, produced: 40, due: isoIn(1), status: "in_progress", line: "Line A" },
    { id: "SO-1050", product: "Widget B", qty: 800, produced: 0, due: isoIn(4), status: "queued", line: "Line A" },
  ],
  inventory: [
    { sku: "ALU-BAR", name: "Aluminium bar stock", qty: 400, reorderPoint: 120 },
    { sku: "FASTENERS", name: "Fastener kit", qty: 900, reorderPoint: 250 },
    { sku: "CARTONS", name: "Shipping cartons", qty: 350, reorderPoint: 100 },
  ],
  events: [], // ring buffer, newest first
};

function isoIn(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function logEvent(kind, message, data = {}) {
  state.events.unshift({ at: new Date().toISOString(), kind, message, ...data });
  state.events.length = Math.min(state.events.length, 200);
  console.log(`[event] ${kind}: ${message}`);
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

// ── Sim tick ─────────────────────────────────────────────────────────────────
async function tick(deps = { fetch, random: Math.random }) {
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
}

// ── Read/act API ─────────────────────────────────────────────────────────────
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function serve() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://x`);
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (req.method === "GET" && parts.length === 0) {
        return json(res, 200, {
          service: "factory-gateway",
          autoEvents,
          endpoints: ["GET /machines", "GET /machines/:id", "GET /orders", "GET /inventory", "GET /events", "POST /sim/start", "POST /sim/stop", "POST /machines/:id/repair", "POST /machines/:id/fault"],
        });
      }
      if (req.method === "POST" && parts[0] === "sim" && (parts[1] === "start" || parts[1] === "stop")) {
        autoEvents = parts[1] === "start";
        logEvent("sim", `auto events ${autoEvents ? "started" : "stopped"}`);
        return json(res, 200, { autoEvents });
      }
      if (req.method === "GET" && parts[0] === "machines" && !parts[1]) return json(res, 200, state.machines);
      if (req.method === "GET" && parts[0] === "machines" && parts[1]) {
        const machine = state.machines.find((m) => m.id === parts[1]);
        return machine ? json(res, 200, machine) : json(res, 404, { error: "machine not found" });
      }
      if (req.method === "GET" && parts[0] === "orders") return json(res, 200, state.orders);
      if (req.method === "GET" && parts[0] === "inventory") return json(res, 200, state.inventory);
      if (req.method === "GET" && parts[0] === "events") return json(res, 200, state.events.slice(0, 50));

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
  console.log("self-check ok");
}

const mode = process.argv[2];
if (mode === "--check") await check();
else if (mode === "install-skill") await installSkill();
else serve();
