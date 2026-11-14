#!/usr/bin/env node
'use strict';

/**
 * Etapa load_tests da esteira do Marco 3 (Guia M3 §16; sprint C9 "Carga, segurança"), no modelo de scripts/loadTestAi.js e
 * scripts/loadTestIntegrations.js. Só em banco descartável com o seed de duas empresas:
 *   node scripts/withDisposableDb.js -- bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && node scripts/loadTestMarco3.js"
 * Volume: `carga` de scripts/ci-marco3/etapas.json (tamanho da carga e limite de p95 da esteira, DI-M3CB-41), nunca meta de negócio.
 * Sai com 0 só se nenhuma invariante do livro for violada (pessoa única por CPF sob concorrência, nada perdido, oportunidade ativa sempre
 * com próxima ação, Radar idempotente sob reprocessamento simultâneo, isolamento entre empresas, p95 das leituras comuns no limite).
 * Grava o relatório em docs/evidencias/m3/carga/carga-<data>.json (ou em --relatorio).
 */
const fs = require('node:fs');
const path = require('node:path');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };

function exigirBancoDescartavel(env = process.env) {
  if (env.DISPOSABLE_DB !== '1') throw new Error('A carga do Marco 3 só roda em banco descartável (node scripts/withDisposableDb.js -- ...): nunca contra a homologação.');
}

async function main() {
  exigirBancoDescartavel();
  const { carga } = JSON.parse(fs.readFileSync(path.join(__dirname, 'ci-marco3', 'etapas.json'), 'utf8'));
  const { empresas, sequelize } = require('./m3-load/ambiente');
  const { executarCarga } = require('./m3-load/executar');
  let relatorio;
  try {
    relatorio = await executarCarga(await empresas(), carga);
  } finally {
    await sequelize.close();
  }
  const arquivo = path.resolve(arg('--relatorio') || path.join(__dirname, '..', 'docs', 'evidencias', 'm3', 'carga', `carga-${relatorio.executadoEm.slice(0, 10)}.json`));
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, `${JSON.stringify(relatorio, null, 2)}\n`);
  const { banco, ...resumo } = relatorio;
  console.log(JSON.stringify({ ...resumo, registro: path.relative(process.cwd(), arquivo) }, null, 2));
  process.exitCode = relatorio.ok ? 0 : 1;
}

if (require.main === module) main().catch((e) => { console.error(`Erro: ${e.message}`); process.exitCode = 1; });

module.exports = { exigirBancoDescartavel };
