'use strict';

// M9-D023 — duas conexões: enquanto uma reindexação ainda não foi confirmada a busca vê só a versão antiga; confirmada, só a nova (nunca
// as duas ACTIVE). Commita dados: só roda no cluster descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withTenantTransaction } = require('../../testHelpers');
const { FileLink } = require('../../../src/models');
const knowledge = require('../../../src/features/ai/knowledge');
const { runAiRagJob } = require('../../../src/engines/jobs/aiRagJob');
const { sequelize, uid, q, carregarPessoas, ctxDe, prepararTenants, comPerm, servico, enviarPdf, ingerirArquivo } = require('../_helpers/ragEnv');

const SKIP = process.env.DISPOSABLE_DB === '1' ? false : 'precisa do cluster descartável (nunca commitar no banco do .env)';
// Os testes que COMMITAM usam a empresa B do seed: os de rollback (empresa A) nunca enxergam o que fica gravado aqui.
let tenantA;
before(async () => { ({ tenantB: tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

async function abrirTransacao(tenant) {
  const tx = await sequelize.transaction();
  await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: tx });
  await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: tx });
  return tx;
}

test('m9d023_busca_durante_a_troca_de_versao_ve_uma_versao_so', { skip: SKIP }, async () => {
  const ana = comPerm(ctxDe(tenantA), 'ai:use', 'ai:admin');
  const f = await withTenantTransaction(tenantA, (tx) => enviarPdf(tenantA, tx, { userId: ana.userId, linhas: ['Cláusula de garantia: caução de três aluguéis.', 'A caução é devolvida em até trinta dias.'] }));
  await withTenantTransaction(tenantA, (tx) => ingerirArquivo(ana, f.id, tx));
  const consulta = 'cláusula garantia caução aluguéis';
  const versoes = (r) => [...new Set(r.items.filter((i) => i.sourceId === f.id).map((i) => i.sourceVersion))]; // só este arquivo (a empresa pode ter outros commitados)

  const troca = await abrirTransacao(tenantA);
  try {
    assert.equal((await ingerirArquivo(ana, f.id, troca, { reindex: true })).ingestion.sourceVersion, 2);
    const durante = await withTenantTransaction(tenantA, (tx) => servico.search(ana, consulta, {}, tx));
    assert.deepEqual(versoes(durante), [1], 'a troca ainda não foi confirmada: só a versão 1, inteira');
    await troca.commit();
  } catch (err) { await troca.rollback().catch(() => {}); throw err; }

  const depois = await withTenantTransaction(tenantA, (tx) => servico.search(ana, consulta, {}, tx));
  assert.deepEqual(versoes(depois), [2], 'confirmada a troca: só a versão 2');
  const ativas = await withTenantTransaction(tenantA, (tx) => q("SELECT count(DISTINCT source_version)::int AS n FROM ai.chunks WHERE source_id = :id AND status = 'ACTIVE'", { id: f.id }, tx));
  assert.equal(ativas[0].n, 1);
});

test('m9d023_job_do_rag_processa_a_fila_e_reconcilia_dentro_do_prazo', { skip: SKIP }, async () => {
  const ana = comPerm(ctxDe(tenantA), 'ai:use', 'ai:admin');
  const outra = comPerm(ctxDe(tenantA), 'ai:admin');
  const entrada = await withTenantTransaction(tenantA, async (tx) => {
    const e = await knowledge.createEntry(ana, { factKey: `job.${uid().slice(0, 8)}`, subjectType: 'politica', title: 'Política de carência', value: { regra: 'Carência de 30 dias para reajuste' }, classification: 'INTERNAL' }, tx);
    await knowledge.homologate(outra, e.id, tx);
    return e;
  });
  const f = await withTenantTransaction(tenantA, (tx) => enviarPdf(tenantA, tx, { userId: ana.userId, linhas: ['Laudo de vistoria de saída do imóvel, com fotos e observações.'] }));
  await withTenantTransaction(tenantA, (tx) => ingerirArquivo(ana, f.id, tx));
  await withTenantTransaction(tenantA, (tx) => FileLink.create({ groupId: tenantA.groupId, companyId: tenantA.companyId, fileId: f.id, relatedEntityType: 'InspectionItem', relatedEntityId: uid() }, { transaction: tx }));
  const resumo = await runAiRagJob({ force: true, companyIds: [tenantA.companyId] });
  assert.equal(resumo.errors, 0);
  assert.ok(resumo.ingested >= 1 && resumo.updated >= 1);
  const { ing, chunk } = await withTenantTransaction(tenantA, async (tx) => ({
    ing: (await q("SELECT status FROM ai.ingestions WHERE source_id = :id", { id: entrada.id }, tx))[0],
    chunk: (await q("SELECT required_permission, owner_scope FROM ai.chunks WHERE source_id = :id", { id: f.id }, tx))[0],
  }));
  assert.equal(ing.status, 'INDEXED', 'a ingestão automática do conhecimento chegou ao fim sem ato humano');
  assert.deepEqual([chunk.required_permission, chunk.owner_scope], ['legal:read', 'COMPANY'], 'a permissão do módulo dono foi copiada para o chunk');
  assert.equal((await runAiRagJob({ force: true, companyIds: [tenantA.companyId] })).updated, 0, 'segunda passada não muda nada');
});
