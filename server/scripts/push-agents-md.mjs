// Push docs/company-agents/*.md into a Paperclip instance's agents, matching
// files to agents by name (Backend-Engineer-1.md -> "Backend Engineer 1").
//
// Usage:
//   cd server && pnpm exec tsx scripts/push-agents-md.mjs <companyId> [--dry-run]
//
// Env:
//   PAPERCLIP_URL    target instance (default http://localhost:3100)
//   PAPERCLIP_TOKEN  board API key (Bearer) for authenticated instances
//
// CEO-*.md companions (HEARTBEAT/SOUL/TOOLS) upload as extra files in the
// CEO's instructions bundle.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [companyId] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");
if (!companyId) {
  console.error("Usage: tsx scripts/push-agents-md.mjs <companyId> [--dry-run]");
  process.exit(1);
}

const BASE = (process.env.PAPERCLIP_URL ?? "http://localhost:3100").replace(/\/$/, "");
const headers = { "content-type": "application/json" };
if (process.env.PAPERCLIP_TOKEN) headers.authorization = `Bearer ${process.env.PAPERCLIP_TOKEN}`;

async function api(method, url, body) {
  const res = await fetch(`${BASE}/api${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/company-agents");
const fileNames = (await fs.readdir(docsDir)).filter((f) => f.endsWith(".md"));

const agentsRes = await api("GET", `/companies/${companyId}/agents`);
if (agentsRes.status !== 200) {
  console.error(`Failed to list agents: ${agentsRes.status} ${JSON.stringify(agentsRes.json)}`);
  process.exit(1);
}
const agents = agentsRes.json.agents ?? agentsRes.json;
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const byName = new Map(agents.map((a) => [norm(a.name), a]));

let ok = 0;
const missing = [];
for (const fileName of fileNames.sort()) {
  const ceoCompanion = fileName.match(/^CEO-(HEARTBEAT|SOUL|TOOLS)\.md$/);
  const agentKey = ceoCompanion ? "ceo" : norm(fileName.replace(/\.md$/, ""));
  const bundlePath = ceoCompanion ? `${ceoCompanion[1]}.md` : "AGENTS.md";
  const agent = byName.get(agentKey);
  if (!agent) {
    missing.push(fileName);
    continue;
  }
  const content = await fs.readFile(path.join(docsDir, fileName), "utf8");
  if (dryRun) {
    console.log(`would push ${fileName} -> ${agent.name} (${bundlePath})`);
    ok += 1;
    continue;
  }
  const res = await api("PUT", `/agents/${agent.id}/instructions-bundle/file`, { path: bundlePath, content });
  if (res.status !== 200) {
    console.error(`FAILED ${fileName} -> ${agent.name}: ${res.status} ${JSON.stringify(res.json)}`);
    process.exit(1);
  }
  // The adapter injects only the bundle's entry file into the system prompt,
  // so make sure it's AGENTS.md — a drifted entry (e.g. HEARTBEAT.md) means
  // the pushed instructions are never read at run time.
  if (bundlePath === "AGENTS.md") {
    const patch = await api("PATCH", `/agents/${agent.id}/instructions-bundle`, { entryFile: "AGENTS.md" });
    if (patch.status !== 200) {
      console.error(`FAILED entry-file pin -> ${agent.name}: ${patch.status} ${JSON.stringify(patch.json)}`);
      process.exit(1);
    }
  }
  console.log(`pushed ${fileName} -> ${agent.name} (${bundlePath})`);
  ok += 1;
}

console.log(`\ndone: ${ok}/${fileNames.length} files${dryRun ? " (dry run)" : ""}`);
if (missing.length > 0) console.log(`no matching agent for: ${missing.join(", ")}`);
