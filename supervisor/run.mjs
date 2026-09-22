// CLI entry point: load a JSON config, build the MCP client + journal + supervisor,
// and run until SIGINT/SIGTERM.
//
//   node supervisor/run.mjs --config supervisor/config.json
//   node supervisor/run.mjs supervisor/config.json
//
// Nothing here is project-specific; everything comes from the config file.

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMcpClient } from './mcp.mjs';
import { openJournal } from './journal.mjs';
import { createSupervisor } from './supervisor.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const USAGE = `OpenAgile supervisor

Usage:
  node supervisor/run.mjs [--config <path>] [<path>]

Config defaults to supervisor/config.json (or $OPENAGILE_SUPERVISOR_CONFIG).
See supervisor/config.example.json for every field.`;

function parseArgs(argv) {
  const out = { config: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (arg === '--config' || arg === '-c') { out.config = argv[i + 1] || ''; i += 1; continue; }
    if (!arg.startsWith('-') && !out.config) out.config = arg;
  }
  return out;
}

// Relative config paths (journal, worker cwd) resolve against the directory the
// supervisor was launched from, so shell commands read naturally.
function resolvePath(value) {
  if (typeof value !== 'string' || !value.trim()) return value;
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function makeLogger() {
  const prefix = '[supervisor]';
  const debug = process.env.SUPERVISOR_DEBUG === '1';
  return {
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    debug: (...args) => { if (debug) console.log(`${prefix}[debug]`, ...args); }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return; }

  const logger = makeLogger();
  const configPath = resolve(args.config
    || process.env.OPENAGILE_SUPERVISOR_CONFIG
    || resolve(HERE, 'config.json'));

  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read config ${configPath}: ${err.message}`);
  }

  const config = JSON.parse(raw);
  const cfg = {
    ...config,
    journalPath: resolvePath(config.journalPath || resolve(HERE, 'supervisor-journal.jsonl')),
    workerCwd: config.workerCwd ? resolvePath(config.workerCwd) : process.cwd()
  };

  if (!cfg.mcpUrl) throw new Error('config.mcpUrl is required');
  if (!cfg.workerCommand) throw new Error('config.workerCommand is required');

  logger.info(`config ${configPath}`);
  logger.info(`mcp    ${cfg.mcpUrl}`);
  logger.info(`journal ${cfg.journalPath}`);

  const client = createMcpClient({ url: cfg.mcpUrl, clientName: cfg.agentName || 'openagile-supervisor' });
  const journal = openJournal({ path: cfg.journalPath });
  const supervisor = createSupervisor({ client, journal, config: cfg, logger });

  let shuttingDown = false;
  const shutdown = async (signal, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} — stopping`);
    try { await supervisor.stop(); } catch (err) { logger.error(`stop failed: ${err.message}`); }
    try { await client.close(); } catch { /* ignore */ }
    journal.close();
    process.exit(code);
  };

  process.on('SIGINT', () => { shutdown('SIGINT', 0); });
  process.on('SIGTERM', () => { shutdown('SIGTERM', 0); });

  supervisor.start().catch(async (err) => {
    logger.error(`fatal: ${err.message}`);
    await shutdown('fatal', 1);
  });
}

main().catch((err) => {
  console.error('[supervisor] failed to start:', err.message);
  process.exit(1);
});
