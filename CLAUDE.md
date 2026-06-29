# CLAUDE.md

## Project

This folder is the local checkout of **Paperclip**.

Paperclip is a Node.js server and React UI for managing AI agents, tasks, goals, org charts, heartbeats, governance, budgets, and agent workspaces.

The goal is to run Paperclip locally first, then optionally customize it for agent/company workflows.

---

## Important Rules for Claude

1. Do not delete local Paperclip data unless explicitly asked.
2. Do not remove or overwrite `.env`, config files, database files, or local storage without permission.
3. Do not commit API keys or secrets.
4. Prefer small, safe commands first.
5. Explain failures clearly and give the next command to try.
6. Assume the user already downloaded this GitHub folder.
7. Work from the repository root unless told otherwise.

---

## First-Time Local Run

From the Paperclip folder:

```bash
cd /path/to/paperclip
```

Check Node and pnpm:

```bash
node --version
pnpm --version
```

Paperclip requires:

```text
Node.js 20+
pnpm 9.15+
```

If pnpm is missing:

```bash
npm install -g pnpm
```

Install dependencies:

```bash
pnpm install
```

Run Paperclip with the local bootstrap flow:

```bash
pnpm paperclipai run
```

Open:

```text
http://localhost:3100
```

---

## Development Mode

Use this when editing or debugging the source code:

```bash
pnpm dev
```

This should start the full local stack:

```text
UI:  http://localhost:3100
API: http://localhost:3100/api
```

---

## Local Runtime Data

Paperclip stores local instance data under:

```text
~/.paperclip/instances/default/
```

Important files and folders may include:

```text
config.json
.env
db/
data/storage/
logs/
secrets/master.key
workspaces/
projects/
```

Do not delete these unless the user asks for a reset.

---

## Useful Commands

Check Paperclip configuration:

```bash
pnpm paperclipai env
```

Run diagnostics:

```bash
pnpm paperclipai doctor
```

Run diagnostics with repair:

```bash
pnpm paperclipai doctor --repair
```

Reconfigure database:

```bash
pnpm paperclipai configure --section database
```

Reconfigure server settings:

```bash
pnpm paperclipai configure --section server
```

Reconfigure storage:

```bash
pnpm paperclipai configure --section storage
```

Run tests:

```bash
pnpm test
```

Run tests in watch mode:

```bash
pnpm test:watch
```

Run browser/e2e tests only when needed:

```bash
pnpm test:e2e
```

---

## API Keys for Agents

If using Claude or OpenAI-backed agents, set keys in the environment or local config.

For Claude:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

For OpenAI/Codex:

```bash
export OPENAI_API_KEY="sk-..."
```

Never paste real keys into committed files.

If Claude Code CLI is needed, check:

```bash
claude --version
```

If Codex CLI is needed, check:

```bash
codex --version
```

---

## Port Issues

Default port:

```text
3100
```

If port 3100 is already in use, run with another port:

```bash
PORT=3200 pnpm paperclipai run
```

Then open:

```text
http://localhost:3200
```

---

## Docker Alternative

Use Docker only if local Node/pnpm setup is difficult.

Build and run:

```bash
docker build -t paperclip-local .

docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Open:

```text
http://localhost:3100
```

With API keys:

```bash
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Docker Compose option:

```bash
docker compose -f docker/docker-compose.quickstart.yml up --build
```

If the repo has `docker-compose.quickstart.yml` in the root instead, use:

```bash
docker compose -f docker-compose.quickstart.yml up --build
```

---

## Troubleshooting

### pnpm not found

```bash
npm install -g pnpm
pnpm --version
```

### Node version too old

Use Node 20+.

With nvm:

```bash
nvm install 20
nvm use 20
```

### Paperclip will not start

Run:

```bash
pnpm paperclipai doctor --repair
```

Then try:

```bash
pnpm paperclipai run
```

### Port already in use

```bash
PORT=3200 pnpm paperclipai run
```

### Database or migration problem

Do not reset automatically. First try:

```bash
pnpm db:migrate
```

Only if the user explicitly wants a clean reset, remove the local database.

For repo dev database:

```bash
rm -rf data/pglite
pnpm dev
```

For Paperclip default instance database:

```bash
rm -rf ~/.paperclip/instances/default/db
pnpm paperclipai run
```

### Docker container will not start

```bash
docker logs paperclip
```

Make sure the data folder exists:

```bash
mkdir -p ./data/docker-paperclip
chmod 755 ./data/docker-paperclip
```

---

## Recommended Workflow for Claude

When asked to run Paperclip:

1. Confirm current directory:
   ```bash
   pwd
   ls
   ```

2. Check runtime:
   ```bash
   node --version
   pnpm --version
   ```

3. Install dependencies if needed:
   ```bash
   pnpm install
   ```

4. Run diagnostics:
   ```bash
   pnpm paperclipai doctor
   ```

5. Start Paperclip:
   ```bash
   pnpm paperclipai run
   ```

6. Tell the user to open:
   ```text
   http://localhost:3100
   ```

When asked to develop or modify Paperclip:

1. Use:
   ```bash
   pnpm dev
   ```

2. Make minimal changes.
3. Run targeted tests first.
4. Run full tests only before final handoff:
   ```bash
   pnpm test
   ```

---

## Do Not Do Without Permission

Do not run these without explicit approval:

```bash
rm -rf ~/.paperclip
rm -rf ~/.paperclip/instances/default/db
rm -rf data/pglite
docker volume prune
docker system prune
git reset --hard
git clean -fdx
```

---

## Success Criteria

Paperclip is considered running when:

1. The terminal shows the server started successfully.
2. No blocking migration or config errors remain.
3. The browser opens:
   ```text
   http://localhost:3100
   ```
4. The UI loads.
5. The user can create or view a company, task, agent, or workspace.
