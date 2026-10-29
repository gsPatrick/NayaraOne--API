#!/usr/bin/env node
'use strict';

/**
 * M9-D810 §3.5 — ÚNICO gerador do arquivo do registro de lineage (docs/governance/lineage-registry.json).
 *   npm run sync:lineage            gera o arquivo: aplica as sementes (src/features/core-governance/lineage/seeds/*.seed.js) a um grupo do banco local
 *                                   descartável e exporta o registro para o arquivo
 *   npm run sync:lineage -- --check confere o arquivo contra o banco: exit 1 se divergem (nada é escrito)
 * Roda só em banco local descartável (node scripts/withDisposableDb.js): recusa qualquer outro, inclusive o do .env. O texto é determinístico.
 */
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.resolve(__dirname, '../docs/governance/lineage-registry.json');

function localDisposable() {
  if (process.env.DISPOSABLE_DB !== '1' || !process.env.DATABASE_URL || !process.env.DATABASE_ADMIN_URL) return false;
  try { return ['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname); } catch (_err) { return false; }
}

async function pickGroup(requested) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  try {
    const { rows } = await client.query(requested ? 'SELECT id FROM core.groups WHERE id = $1' : 'SELECT id FROM core.groups ORDER BY id LIMIT 1', requested ? [requested] : []);
    return rows[0] ? rows[0].id : null;
  } finally { await client.end(); }
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const groupArg = args.includes('--group') ? args[args.indexOf('--group') + 1] : null;
  if (!localDisposable()) {
    console.error('Recusado: o gerador do registro de lineage só roda em banco local descartável (node scripts/withDisposableDb.js -- node scripts/syncLineageRegistry.js).');
    process.exit(2);
  }
  const groupId = await pickGroup(groupArg);
  if (!groupId) { console.error('Nenhum grupo encontrado no banco descartável.'); process.exit(2); }
  const { sequelize } = require('../src/models');
  const { ensureSeeded } = require('../src/features/core-governance/lineage/lineage.seed');
  const { buildRegistryFile, diffRegistryFiles } = require('../src/features/core-governance/lineage/lineage.registryFile');
  const tenant = { groupId, companyId: null };
  let text;
  try {
    text = await sequelize.transaction(async (transaction) => {
      await sequelize.query("SELECT set_config('app.group_id', :groupId, true)", { transaction, replacements: { groupId } });
      await ensureSeeded(tenant, transaction);
      return buildRegistryFile(tenant, transaction);
    });
  } finally { await sequelize.close(); }
  if (check) {
    const current = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
    const diff = current ? diffRegistryFiles(current, text) : ['arquivo ausente'];
    if (diff.length) {
      console.error(`GOV_LINEAGE_REGISTRY_DRIFT: ${path.relative(process.cwd(), FILE)} difere das sementes (${diff.length} diferença(s)). Rode npm run sync:lineage e commite o arquivo.`);
      for (const line of diff.slice(0, 20)) console.error(`  ${line}`);
      process.exit(1);
    }
    console.log('Registro de lineage igual às sementes.');
    return;
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, text);
  console.log(`Registro de lineage escrito em ${path.relative(process.cwd(), FILE)}.`);
}

main().catch((err) => { console.error(`ERRO: ${err.message}`); process.exit(1); });
