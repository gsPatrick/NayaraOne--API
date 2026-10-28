'use strict';

// Marco 8 — DIMOB: o modelo do arquivo (colunas, separador, aviso, layout) fica preso a cada versão do lote.
// Mudar as configurações da empresa depois não altera a exportação de um lote já gerado/fechado.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../testHelpers');
const parameters = require('../../src/features/correspondent/parameters.service');
const dimob = require('../../src/features/correspondent/fiscal/dimob.service');
const { Person, Property, DimobBatch, DimobRecord, Contract, ContractParty, FinancialEntry, AuditLog } = require('../../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const ctx = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const a = () => [tenant.userId, tenant.groupId, tenant.companyId];
const gerar = (ano, t) => dimob.generateDimobBatch(ano, tenant.userId, tenant.groupId, tenant.companyId, t);

async function configurar(t, patch) {
  const atual = await parameters.getParameters(tenant.groupId, tenant.companyId, tenant.userId, t);
  return parameters.updateCommission({ ...atual.commission.action, ...patch }, 'Teste do modelo da DIMOB', tenant.userId, tenant.groupId, tenant.companyId, t);
}

async function locacaoCompleta(t, ano) {
  const mk = (nome, doc) => Person.create({ ...ctx(), personType: 'PF', legalName: `${nome} ${uniqueSuffix()}`, taxIdNormalized: doc, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
  const locador = await mk('Locador modelo', '12345678909');
  const locatario = await mk('Locatario modelo', '98765432100');
  const imovel = await Property.create({ ...ctx(), title: `Imovel modelo ${uniqueSuffix()}`, internalCode: `MOD-${uniqueSuffix()}`, propertyType: 'HOUSE', createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
  const contrato = await Contract.create(
    { ...ctx(), contractType: 'LEASE_RESIDENTIAL', contractNumber: `MOD-${uniqueSuffix()}`, status: 'ACTIVE', propertyId: imovel.id, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction: t }
  );
  await ContractParty.create({ ...ctx(), contractId: contrato.id, personId: locador.id, partyRole: 'LANDLORD' }, { transaction: t });
  await ContractParty.create({ ...ctx(), contractId: contrato.id, personId: locatario.id, partyRole: 'TENANT' }, { transaction: t });
  await FinancialEntry.create(
    { ...ctx(), contractId: contrato.id, entryType: 'CREDIT', nature: 'RECEIVABLE', status: 'SETTLED', amount: 1500, description: `Aluguel ${ano}`, dueAt: new Date(Date.UTC(ano, 2, 10)), settledAt: new Date(Date.UTC(ano, 2, 10)), createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction: t }
  );
}

test('M8-DIMOB-MODELO-01: lote fechado exporta igual byte a byte depois de mudar colunas e separador; nova versão traz o modelo novo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ano = 2041;
    await configurar(t, { dimobLayoutLabel: 'MOD-{ano}-A', dimobFileColumns: ['contrato', 'valor_no_ano'], dimobFileDelimiter: ';', dimobFileNotice: 'Aviso A' });
    await locacaoCompleta(t, ano);
    const v1 = await gerar(ano, t);
    assert.ok(v1.fileModelHash && /^[0-9a-f]{64}$/.test(v1.fileModelHash));
    await dimob.closeDimobBatch(v1.id, ...a(), t);

    const A = (await dimob.exportDimobFile(v1.id, ...a(), t)).content;
    assert.match(A, /# modelo;/);
    assert.match(A, /\ncontrato;valor_no_ano\n/);

    await configurar(t, { dimobLayoutLabel: 'MOD-{ano}-B', dimobFileColumns: ['valor_no_ano', 'locador_documento', 'situacao'], dimobFileDelimiter: '|', dimobFileNotice: 'Aviso B' });
    const B = (await dimob.exportDimobFile(v1.id, ...a(), t)).content;
    assert.equal(B, A, 'mudar as configurações não altera o arquivo do lote já fechado');

    const v2 = await gerar(ano, t);
    assert.equal(v2.version, v1.version + 1);
    assert.equal(v2.snapshotHash, v1.snapshotHash, 'mesmo conjunto de dados, mesmo hash do dataset');
    assert.notEqual(v2.fileModelHash, v1.fileModelHash, 'o modelo novo é identificável');
    const C = (await dimob.exportDimobFile(v2.id, ...a(), t)).content;
    assert.notEqual(C, A);
    assert.match(C, /\nvalor_no_ano\|locador_documento\|situacao\n/);
    assert.match(C, new RegExp(`# modelo\\|${v2.fileModelHash}`));
    assert.match(C, /versao\|2\|/);

    // O arquivo antigo continua reproduzível depois da nova versão.
    assert.equal((await dimob.exportDimobFile(v1.id, ...a(), t)).content, A);

    const lista = await dimob.listDimobBatches(ano, tenant.groupId, tenant.companyId, t);
    const porVersao = Object.fromEntries(lista.map((b) => [b.version, b.fileModelHash]));
    assert.equal(porVersao[1], v1.fileModelHash);
    assert.equal(porVersao[2], v2.fileModelHash);

    const trilha = await AuditLog.findAll({ where: { entityId: v1.id }, transaction: t });
    const acoes = trilha.map((x) => x.action);
    assert.ok(acoes.includes('correspondent.dimob.batch_generated'));
    assert.ok(acoes.includes('correspondent.dimob.batch_closed'));
    assert.ok(acoes.filter((x) => x === 'correspondent.dimob.file_exported').length >= 3, 'toda exportação fica na auditoria');
  });
});

test('M8-DIMOB-MODELO-02: lote antigo sem modelo é congelado na primeira exportação e as seguintes saem idênticas; o modelo gravado não muda mais', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ano = 2042;
    await configurar(t, { dimobFileColumns: ['contrato', 'valor_no_ano'], dimobFileDelimiter: ';' });
    await locacaoCompleta(t, ano);
    const base = await gerar(ano, t);
    const registros = await DimobRecord.findAll({ where: { dimobBatchId: base.id }, transaction: t });
    // Lote criado antes desta entrega: fechado e SEM modelo gravado (o gatilho só impede alterar, não criar).
    const lote = await DimobBatch.create(
      { ...ctx(), referenceYear: ano, version: 99, layoutVersion: base.layoutVersion, status: 'CLOSED', snapshotHash: base.snapshotHash, createdBy: tenant.userId },
      { transaction: t }
    );
    assert.equal(lote.fileModelJson, null);
    for (const r of registros) {
      await DimobRecord.create({ ...ctx(), dimobBatchId: lote.id, sourceRefs: r.sourceRefs, amount: r.amount, recordType: r.recordType, validationStatus: r.validationStatus, validationIssues: r.validationIssues, detailJson: r.detailJson }, { transaction: t });
    }

    const primeira = (await dimob.exportDimobFile(lote.id, ...a(), t)).content;
    assert.match(primeira, /\ncontrato;valor_no_ano\n/);
    await configurar(t, { dimobFileColumns: ['situacao'], dimobFileDelimiter: '|' });
    const segunda = (await dimob.exportDimobFile(lote.id, ...a(), t)).content;
    assert.equal(segunda, primeira);

    const trilha = await AuditLog.findAll({ where: { entityId: lote.id, action: 'correspondent.dimob.file_model_frozen' }, transaction: t });
    assert.equal(trilha.length, 1, 'o congelamento é registrado uma única vez');

    await assert.rejects(
      sequelize.query(`UPDATE "correspondent"."dimob_batches" SET file_model_json = '{}'::jsonb WHERE id = :id`, { replacements: { id: lote.id }, transaction: t }),
      /não pode ser alterado/
    );
  });
});
