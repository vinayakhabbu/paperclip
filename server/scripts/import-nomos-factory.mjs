// Import the Nomos Autonomous Factory package (skills + 9 agents) into an
// existing company. Skills are created from skills/<slug>/SKILL.md with
// overwrite:true (safe to re-run); agents are created via the normal create
// endpoint with their 5-file instruction bundle inline (entryFile AGENTS.md)
// on claude_local (adapter defaults handle model + heartbeat lanes). Director
// is created first so everyone else's reportsTo can point at it.
//
// Usage:
//   node scripts/import-nomos-factory.mjs <companyId> [--dry-run]
//
// Env:
//   PAPERCLIP_URL    target instance (default http://localhost:3100)
//   PAPERCLIP_TOKEN  board API key (Bearer) for authenticated instances
//   NOMOS_SRC        package dir (default ~/Downloads/nomos_factory_functional_agents)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SRC = process.env.NOMOS_SRC
  ?? path.join(os.homedir(), "Downloads", "nomos_factory_functional_agents");
const ADAPTER = "claude_local";

// Per-agent Claude model alias, mapped from the manifest's modelGuidance
// tiers: premium/conservative reasoning gets opus, everyone else the sonnet
// default. Aliases track the CLI's latest models so they don't go stale.
const MODEL_BY_AGENT = {
  "factory-operations-director": "opus",
  "safety-policy-agent": "opus",
};
const DEFAULT_MODEL = "sonnet";

const [companyId] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");
if (!companyId) {
  console.error("Usage: node scripts/import-nomos-factory.mjs <companyId> [--dry-run]");
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

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "agent-manifest.json"), "utf8"));

// ── 1. Skills ────────────────────────────────────────────────────────────────
const skillsDir = path.join(SRC, "skills");
const skillSlugs = fs.readdirSync(skillsDir).filter((s) => !s.startsWith("."));
for (const slug of skillSlugs) {
  const markdown = fs.readFileSync(path.join(skillsDir, slug, "SKILL.md"), "utf8");
  const name = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  if (dryRun) {
    console.log(`would create skill ${slug}`);
    continue;
  }
  const res = await api("POST", `/companies/${companyId}/skills`, {
    name, slug, markdown, overwrite: true,
  });
  if (res.status >= 300) {
    console.error(`FAILED skill ${slug}: ${res.status} ${JSON.stringify(res.json)}`);
    process.exit(1);
  }
  console.log(`skill ${slug} ok`);
}

// ── 2. Agents (director first so reportsTo can be wired) ────────────────────
const existingSkills = dryRun
  ? []
  : (await api("GET", `/companies/${companyId}/skills`)).json ?? [];
const knownRefs = new Set(
  (Array.isArray(existingSkills) ? existingSkills : []).flatMap((s) => [s.slug, s.key].filter(Boolean)),
);

const agents = [...manifest.agents].sort((a, b) =>
  (a.shortName === "factory-operations-director" ? -1 : 0) - (b.shortName === "factory-operations-director" ? -1 : 0),
);

let directorId = null;
for (const agent of agents) {
  const bundleDir = path.join(SRC, agent.instructionsBundlePath);
  const files = Object.fromEntries(
    fs.readdirSync(bundleDir)
      .filter((f) => !f.startsWith("."))
      .map((f) => [f, fs.readFileSync(path.join(bundleDir, f), "utf8")]),
  );
  const desiredSkills = dryRun
    ? agent.desiredSkills
    : agent.desiredSkills.filter((ref) => {
        if (knownRefs.has(ref)) return true;
        console.warn(`  warn: ${agent.shortName} skill "${ref}" not found in company, skipping ref`);
        return false;
      });
  const model = MODEL_BY_AGENT[agent.shortName] ?? DEFAULT_MODEL;
  const reportsTo = agent.reportsTo.includes("Director") ? directorId : null;

  if (dryRun) {
    console.log(`would create agent ${agent.name} (model=${model}, reportsTo=${reportsTo ?? "human"}, skills=${desiredSkills.join(",")})`);
    continue;
  }

  const res = await api("POST", `/companies/${companyId}/agents`, {
    name: agent.name,
    title: agent.title,
    reportsTo,
    adapterType: ADAPTER,
    adapterConfig: { model },
    instructionsBundle: { entryFile: "AGENTS.md", files },
    desiredSkills,
  });
  if (res.status >= 300) {
    console.error(`FAILED agent ${agent.name}: ${res.status} ${JSON.stringify(res.json)}`);
    process.exit(1);
  }
  const created = res.json.agent ?? res.json;
  if (agent.shortName === "factory-operations-director") directorId = created.id;
  console.log(`agent ${agent.name} ok (${created.id})`);
}

console.log(`\ndone${dryRun ? " (dry run)" : ""}: ${skillSlugs.length} skills, ${agents.length} agents`);
