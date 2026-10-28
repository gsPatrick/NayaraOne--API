'use strict';

// M9-D028 — job diário de expurgo (aiRetentionJob): percorre as empresas, respeita o intervalo do parâmetro e não derruba uma
// empresa por falha de outra. Grava linhas COMMITADAS: roda só em banco descartável (os runs são imutáveis e não se apagam).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { runAiRetentionJob } = require('../../../src/engines/jobs/aiRetentionJob');
const { sequelize, q, prepararTenants } = require('../../helpers/aiRuns');
const { runVelho, lerRunCompleto } = require('../_helpers/iaRetencao');

let tenantA;
let tenantB;
before(async () => { ({ tenantA, tenantB } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

async function comoTenant(tenant, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    return fn(transaction);
  });
}

test('m9d028_job_diario_expurga_e_respeita_intervalo', async () => {
  const velhoA = await comoTenant(tenantA, (tx) => runVelho(tenantA, tx, { diasAtras: 400, fontes: ['PUBLIC'] }));
  const velhoB = await comoTenant(tenantB, (tx) => runVelho(tenantB, tx, { diasAtras: 400, fontes: [] }));
  const novoA = await comoTenant(tenantA, (tx) => runVelho(tenantA, tx, { diasAtras: 5, fontes: ['RESTRICTED'] }));
  const r = await runAiRetentionJob({ force: true });
  assert.equal(r.errors, 0);
  assert.ok(r.runs >= 2, 'os dois runs vencidos foram expurgados');
  assert.ok((await comoTenant(tenantA, (tx) => lerRunCompleto(velhoA.id, tx))).content_purged_at);
  assert.ok((await comoTenant(tenantB, (tx) => lerRunCompleto(velhoB.id, tx))).content_purged_at);
  const recente = await comoTenant(tenantA, (tx) => lerRunCompleto(novoA.id, tx));
  assert.equal(recente.content_purged_at, null);
  assert.equal(recente.input_summary, 'entrada sanitizada');
  // Dentro do intervalo de 24 h (parâmetro) a mesma empresa não é varrida de novo.
  const outra = await runAiRetentionJob();
  assert.equal(outra.companies, 0);
  const [{ n }] = await comoTenant(tenantA, (tx) => q('SELECT count(*)::int AS n FROM ai.ai_sources WHERE ai_run_id = :id AND excerpt IS NULL', { id: velhoA.id }, tx));
  assert.equal(n, 1);
});
