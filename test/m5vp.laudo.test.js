'use strict';

/**
 * Fechamento M5 (vistorias e prazos) — M5-A0091, livro §11 "Assinatura congela a versão" e "Correção após assinatura cria
 * addendum/revision, não altera laudo original": o laudo PDF de vistoria assinada por locador e locatário é emitido uma vez e
 * não é regerado nem tem o hash trocado (serviço e banco). Antes da assinatura completa ele ainda pode ser regerado.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const inspectionsService = require('../src/modules/legal/inspections/inspection.service');
const propertiesService = require('../src/features/properties/properties.service');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const code = (c) => (err) => { assert.equal(err.code, c, `${err.code}: ${err.message}`); return true; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function completedInspection(t) {
  const sfx = uniqueSuffix();
  const p = await propertiesService.createProperty({ ...base(), propertyType: 'RESIDENTIAL', title: `Laudo ${sfx}`, internalCode: `M5VP-L-${sfx}` }, tenant.userId, t);
  const ins = await inspectionsService.createInspection({ ...base(), propertyId: p.id, inspectionType: 'ENTRY' }, tenant.userId, t);
  await inspectionsService.completeInspection(ins.id, tenant.userId, t);
  return ins;
}

test('M5-A0091/§11: laudo de vistoria assinada é emitido uma vez e não é regerado; o banco também recusa trocar o hash', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ins = await completedInspection(t);
    // Antes da assinatura completa o laudo pode ser regerado (rascunho do laudo).
    const draft1 = await inspectionsService.generateInspectionReport(ins.id, tenant.userId, t);
    await inspectionsService.signInspection(ins.id, { partyRole: 'LANDLORD', signaturePayload: 'l' }, tenant.userId, t);
    await wait(1100);
    const draft2 = await inspectionsService.generateInspectionReport(ins.id, tenant.userId, t);
    assert.notEqual(draft2.reportHash, draft1.reportHash, 'com uma só assinatura ainda é rascunho');
    await wait(20);
    await inspectionsService.signInspection(ins.id, { partyRole: 'TENANT', signaturePayload: 't' }, tenant.userId, t);

    // Assinada pelas duas partes: o laudo sai uma vez (com as assinaturas) e congela.
    await wait(20);
    const signed = await inspectionsService.generateInspectionReport(ins.id, tenant.userId, t);
    await wait(1100);
    await assert.rejects(() => inspectionsService.generateInspectionReport(ins.id, tenant.userId, t), code('LEGAL_INSPECTION_REPORT_FROZEN'));
    const stored = await inspectionsService.getInspectionReport(ins.id, t);
    assert.equal(stored.reportHash, signed.reportHash, 'o laudo guardado continua o original');

    // Por baixo do serviço: trocar bytes ou hash direto na tabela é recusado pelo gatilho.
    let err = null;
    try {
      await sequelize.transaction({ transaction: t }, (sp) => sequelize.query("UPDATE legal.inspections SET report_hash = repeat('0', 64) WHERE id = :id", { replacements: { id: ins.id }, transaction: sp }));
    } catch (e) { err = e; }
    assert.match(String(err && err.message), /LEGAL_INSPECTION_REPORT_FROZEN/);
    assert.equal((await inspectionsService.getInspectionReport(ins.id, t)).reportHash, signed.reportHash);

    // Corrigir continua possível pela revisão (o original fica intacto).
    const revision = await inspectionsService.createInspectionRevision(ins.id, { reason: 'Correção do item da sala depois da assinatura' }, tenant.userId, t);
    assert.ok(revision && revision.id && revision.id !== ins.id);
  });
});

test('M5-A0091/§11: vistoria assinada que ainda não tinha laudo gera o primeiro laudo normalmente', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ins = await completedInspection(t);
    await inspectionsService.signInspection(ins.id, { partyRole: 'LANDLORD', signaturePayload: 'l' }, tenant.userId, t);
    await inspectionsService.signInspection(ins.id, { partyRole: 'TENANT', signaturePayload: 't' }, tenant.userId, t);
    const first = await inspectionsService.generateInspectionReport(ins.id, tenant.userId, t);
    assert.match(first.reportHash, /^[0-9a-f]{64}$/);
    await assert.rejects(() => inspectionsService.generateInspectionReport(ins.id, tenant.userId, t), code('LEGAL_INSPECTION_REPORT_FROZEN'));
  });
});
