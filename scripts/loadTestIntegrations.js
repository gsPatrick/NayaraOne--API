#!/usr/bin/env node
'use strict';

/**
 * M9-D255 3.3 — teste de carga das integrações (modelo: scripts/loadTestAi.js). Só em banco descartável com o seed de duas empresas:
 *   node scripts/withDisposableDb.js -- bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && node scripts/loadTestIntegrations.js"
 * Volume: parâmetros integration.load.* da empresa (padrão 50 webhooks/s e 20 envios/s por 5 min), só como tamanho da carga. Sai com 0 só se não
 * houver evento perdido, envio duplicado nem fila sem drenar; grava o relatório em docs/evidencias/integracoes/carga/.
 */
const path = require('node:path');

function exigirBancoDescartavel(env = process.env) {
  if (env.DISPOSABLE_DB !== '1') throw new Error('A carga das integrações só roda em banco descartável (node scripts/withDisposableDb.js -- ...): nunca contra a homologação.');
}

async function main() {
  exigirBancoDescartavel();
  process.env.PORT = process.env.PORT || String(57000 + Math.floor(Math.random() * 900));
  process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE = process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE || '100000'; // o teto de entrada da plataforma no máximo: a carga é do fornecedor, não do limite
  const env = require('../test/marco9/_helpers/m9d255Env');
  const { readLoadParams, loadVolume } = require('../src/features/integrations/load/load.params');
  const { executarCarga } = require('./int-load/executar');
  const desligarCofre = env.useTempSecretStore();
  let relatorio;
  try {
    const { tenant } = await env.carregarTenants();
    const params = await env.comTenant(tenant, (t) => readLoadParams(tenant, t));
    relatorio = { params, ...(await executarCarga(env, tenant, loadVolume(params))) };
  } finally {
    desligarCofre();
    await env.sequelize.close();
  }
  const arquivo = require('./int-load/relatorio').gravarRelatorio(relatorio);
  console.log(JSON.stringify({ ...relatorio, registro: path.relative(process.cwd(), arquivo) }, null, 2));
  process.exit(relatorio.ok ? 0 : 1);
}

main().catch((e) => { console.error(`Erro: ${e.message}`); process.exit(1); });
