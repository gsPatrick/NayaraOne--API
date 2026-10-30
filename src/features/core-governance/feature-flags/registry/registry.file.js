'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadSeedFlags } = require('./registry.seeds');

const SEEDS_DIR = path.resolve(__dirname, '../seeds');
const REGISTRY_FILE = path.resolve(__dirname, '../../../../../docs/governance/flags.json');

/** Texto determinístico do arquivo de flags (sem data de geração, para o `--check` comparar byte a byte). */
const renderRegistry = (flags) => `${JSON.stringify({ version: 1, generatedBy: 'scripts/syncFlagsRegistry.js', flags }, null, 2)}\n`;

const buildRegistryText = (seedsDir = SEEDS_DIR) => renderRegistry(loadSeedFlags(seedsDir));

function readRegistry(file = REGISTRY_FILE) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || !Array.isArray(parsed.flags)) throw new Error('arquivo de flags sem a lista "flags".');
  return parsed;
}

module.exports = { SEEDS_DIR, REGISTRY_FILE, renderRegistry, buildRegistryText, readRegistry };
