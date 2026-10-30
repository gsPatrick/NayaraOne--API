'use strict';

// Marco 9, M9-D247 (critério vindo da M9-D245) — todo conteúdo baixado por ssrfGuard.fetchExternalUrl entra em files.quarantine com status QUARANTINED antes de ser usado.
// Banco descartável (os testes COMMITAM); servidor HTTPS local com certificado gerado na hora.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, comTenant, carregarTenants } = require('../../integrations/dispatch/dispatchHelpers');
const { registerQuarantineSink, hasQuarantineSink } = require('../../../src/features/integrations/http/ssrf/quarantinePort');
const quarantine = require('../../../src/features/files/quarantine');
const storage = require('../../../src/features/integrations/storage');
const { montarAmbiente, pdf } = require('../_helpers/ssrfEnv');

let tenant;
const abertos = [];
before(async () => { ({ tenant } = await carregarTenants()); storage.ensureStorageRegistered(); });
afterEach(async () => { while (abertos.length) await abertos.pop().fechar(); });
after(async () => { await sequelize.close(); });

const ctx = () => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId });
const linhas = (sha) => comTenant(tenant, async (t) => (await sequelize.query('SELECT * FROM files.quarantine WHERE company_id = :c AND sha256 = :s', { replacements: { c: tenant.companyId, s: sha }, transaction: t }))[0]);

test('ssrf_conteudo_vai_para_quarentena', async () => {
  assert.equal(hasQuarantineSink(), true, 'carregar a quarentena registra o destino real');
  const a = await montarAmbiente((req, res) => {
    res.setHeader('content-type', 'application/pdf');
    res.end(Buffer.from(`%PDF-1.4 documento assinado ${req.url}`));
  });
  abertos.push(a);
  // O download volta marcado QUARANTINED e o conteúdo está gravado em files.quarantine (não só entregue a um destino qualquer).
  const r = await comTenant(tenant, (t) => a.buscar('https://foto.example.test/doc.pdf', { tenant: ctx(), transaction: t }));
  assert.equal(r.quarantine.status, 'QUARANTINED');
  assert.equal(r.quarantine.released, false);
  assert.equal(r.quarantine.sink, 'registered');
  assert.ok(r.quarantine.ref.quarantineId);
  const gravadas = await linhas(r.sha256);
  assert.equal(gravadas.length, 1);
  assert.deepEqual([gravadas[0].id, gravadas[0].status, gravadas[0].declared_mime, gravadas[0].origin_key.includes('import_by_url')], [r.quarantine.ref.quarantineId, 'QUARANTINED', 'application/pdf', true]);
  assert.match(gravadas[0].storage_key, new RegExp(`^company/${tenant.companyId}/quarantine/`));
  // Antes da verificação ninguém usa o arquivo; o mesmo download repetido não cria outra linha.
  await assert.rejects(comTenant(tenant, (t) => quarantine.assertReleased(ctx(), r.quarantine.ref.quarantineId, t)), (e) => e.statusCode === 423);
  await comTenant(tenant, (t) => a.buscar('https://foto.example.test/doc.pdf', { tenant: ctx(), transaction: t }));
  assert.equal((await linhas(r.sha256)).length, 1, 'idempotente por hash + origem');
  // Sem a empresa e a transação não há onde guardar: o download é recusado, nunca fica sem quarentena.
  await assert.rejects(a.buscar('https://foto.example.test/doc.pdf'), (e) => e.code === 'INTEGRATION_FILE_QUARANTINE_CONTEXT_MISSING' || e.code === 'INTEGRATION_SSRF_BLOCKED' || /empresa/.test(e.message));
  registerQuarantineSink(null);
  quarantine.installQuarantine();
  assert.equal(hasQuarantineSink(), false, 'o instalador roda uma só vez por processo');
  registerQuarantineSink(quarantine.quarantineSink);
});

test('ssrf_conteudo_recusado_nunca_chega_a_quarentena', async () => {
  const a = await montarAmbiente((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<script>1</script>'); });
  abertos.push(a);
  const antes = await comTenant(tenant, async (t) => (await sequelize.query('SELECT count(*)::int AS n FROM files.quarantine WHERE company_id = :c', { replacements: { c: tenant.companyId }, transaction: t }))[0][0].n);
  await assert.rejects(comTenant(tenant, (t) => a.buscar('https://foto.example.test/x.html', { tenant: ctx(), transaction: t })), (e) => e.statusCode === 415);
  const depois = await comTenant(tenant, async (t) => (await sequelize.query('SELECT count(*)::int AS n FROM files.quarantine WHERE company_id = :c', { replacements: { c: tenant.companyId }, transaction: t }))[0][0].n);
  assert.equal(depois, antes);
  assert.ok(pdf);
});
