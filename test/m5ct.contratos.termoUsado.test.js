'use strict';

// Verificação independente do Marco 5, linha 69 (Caderno §7 "Imóvel usado: termo específico deixando clara natureza/estado
// conforme modelo jurídico aprovado"): o termo do imóvel usado vem do modelo de contrato USED_PROPERTY_DELIVERY publicado
// (alçada jurídica), não de texto fixo no código. Serviço real, transação desfeita no fim.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const filesService = require('../src/features/files/files.service');
const contractsService = require('../src/modules/legal/contracts/application/contract.service');
const inspectionsService = require('../src/modules/legal/inspections/inspection.service');
const keyDeliveriesService = require('../src/modules/legal/leasing/key-delivery.service');
const templateService = require('../src/modules/legal/contracts/application/template.service');
const clausesService = require('../src/modules/legal/contracts/application/contractClauses.service');
const { SEED } = require('../src/modules/legal/leasing/usedPropertyTermModel');
const { ContractTemplate, TemplateVersion, AuditLog } = require('../src/models');
const { keyDeliveryReady } = require('./m5fech.locacao.helpers');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });
const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const q = (t, sql) => sequelize.query(sql, { transaction: t });
const upload = (t, fileName, mimeType) => filesService.uploadFile({ ...base(), fileName, mimeType, contentBase64: Buffer.from(`${fileName} ${uniqueSuffix()}`).toString('base64'), category: 'generic' }, tenant.userId, t);

/** Entrega de imóvel usado pronta para liberar (locação ACTIVE, vistoria de entrada assinada, checklist dispensado). */
async function entregaUsado(t) {
  const sfx = uniqueSuffix();
  const property = await propertiesService.createProperty({ ...base(), propertyType: 'RESIDENTIAL', title: `M5CT usado ${sfx}`, internalCode: `M5CTU-${sfx}` }, tenant.userId, t);
  const contract = await contractsService.createContract({ ...base(), contractType: 'LEASE_RESIDENTIAL', propertyId: property.id, totalValue: 2000 }, tenant.userId, t);
  contract.status = 'ACTIVE';
  await contract.save({ transaction: t });
  const landlord = await peopleService.createPerson({ ...base(), personType: 'PF', legalName: `M5CT Locador ${sfx}` }, tenant.userId, t);
  const renter = await peopleService.createPerson({ ...base(), personType: 'PF', legalName: `M5CT Locatário ${sfx}` }, tenant.userId, t);
  await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, t);
  await contractsService.addContractParty(contract.id, { personId: renter.id, partyRole: 'TENANT' }, tenant.userId, t);
  const termEvidenceFileId = await keyDeliveryReady(tenant, contract.id, t);
  const ins = await inspectionsService.createInspection({ ...base(), propertyId: property.id, contractId: contract.id, inspectionType: 'ENTRY' }, tenant.userId, t);
  await inspectionsService.completeInspection(ins.id, tenant.userId, t);
  await inspectionsService.signInspection(ins.id, { partyRole: 'LANDLORD', signaturePayload: 'l' }, tenant.userId, t);
  await inspectionsService.signInspection(ins.id, { partyRole: 'TENANT', signaturePayload: 't' }, tenant.userId, t);
  const kd = await keyDeliveriesService.createKeyDelivery({ ...base(), contractId: contract.id, deliveredToPersonId: renter.id, termType: 'USED_PROPERTY_DELIVERY' }, tenant.userId, t);
  const photo = await upload(t, 'sala.jpg', 'image/jpeg');
  return { kd, body: { keysCount: 2, keysIdentification: '2 chaves', termSignedByPersonId: renter.id, termEvidenceFileId, photosFileIds: [photo.id] } };
}

const modelosDoTipo = (t) => ContractTemplate.findAll({ where: { contractType: 'USED_PROPERTY_DELIVERY' }, transaction: t });

test('linha 69: o termo do imóvel usado sai do modelo jurídico publicado — nome e versão no texto, versão gravada na entrega, hash do texto', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    for (const m of await modelosDoTipo(t)) { m.isActive = false; await m.save({ transaction: t }); } // empresa sem modelo do tipo
    const { kd, body } = await entregaUsado(t);
    const preview = await keyDeliveriesService.previewKeyDeliveryTerm(kd.id, {}, t);
    assert.match(preview.termText, /versão inicial, registrada na liberação/);
    const r = await keyDeliveriesService.releaseKeyDelivery(kd.id, body, tenant.userId, t);
    assert.equal(r.termVersion, 'KD-TERM-v4');
    const v = await TemplateVersion.findByPk(r.termTemplateVersionId, { transaction: t });
    assert.equal(v.status, 'PUBLISHED');
    assert.equal(v.origin, 'CODE_SEED');
    assert.ok(r.termText.includes(SEED.bodyText));
    assert.match(r.termText, new RegExp(`modelo jurídico aprovado "${SEED.templateName}", versão 1\\.`));
    assert.equal(r.termHash, crypto.createHash('sha256').update(r.termText, 'utf8').digest('hex'));
    const aud = await AuditLog.findOne({ where: { action: 'legal.contract_template.seed', entityId: v.id }, transaction: t });
    assert.ok(aud, 'a criação da versão inicial do modelo fica auditada');
  });
});

test('linha 69: o jurídico publica nova versão do modelo (legal:approve) e o termo seguinte usa o texto novo; o termo já gravado não muda', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const primeira = await entregaUsado(t);
    const r1 = await keyDeliveriesService.releaseKeyDelivery(primeira.kd.id, primeira.body, tenant.userId, t);
    const v1 = await TemplateVersion.findByPk(r1.termTemplateVersionId, { transaction: t });
    const links = await templateService.listTemplateClauses(v1.templateId, t, v1.id);
    const { clause } = links[0];
    const novoTexto = `O imóvel é entregue usado, no estado da vistoria anexa, com o desgaste natural de uso declarado pelas partes ${uniqueSuffix()}.`;
    const nova = await clausesService.createClauseVersion(clause.code, { bodyText: novoTexto }, tenant.userId, t);
    await templateService.upgradeTemplateClause(v1.templateId, clause.id, tenant.userId, t);
    // Antes de publicar, a versão DRAFT não vale para o termo.
    const rascunho = await entregaUsado(t);
    const rr = await keyDeliveriesService.releaseKeyDelivery(rascunho.kd.id, rascunho.body, tenant.userId, t);
    assert.ok(!rr.termText.includes(novoTexto), 'rascunho do modelo não entra no termo');
    const v2 = await templateService.publishTemplate(v1.templateId, tenant.userId, t);
    assert.equal(v2.versionNumber, v1.versionNumber + 1);
    const segunda = await entregaUsado(t);
    const r2 = await keyDeliveriesService.releaseKeyDelivery(segunda.kd.id, segunda.body, tenant.userId, t);
    assert.ok(r2.termText.includes(nova.bodyText));
    assert.equal(r2.termTemplateVersionId, v2.id);
    assert.match(r2.termText, new RegExp(`versão ${v2.versionNumber}\\.`));
    const relida = await keyDeliveriesService.getKeyDelivery(r1.id, t);
    assert.equal(relida.termHash, r1.termHash, 'termo já gravado não é regerado');
    assert.equal(relida.termTemplateVersionId, v1.id);
  });
});

test('linha 69: modelo do tipo cadastrado mas sem versão publicada bloqueia a liberação (409) — fail closed', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    for (const m of await modelosDoTipo(t)) { m.isActive = false; await m.save({ transaction: t }); }
    await templateService.createTemplate({ ...base(), name: `Termo usado em revisão ${uniqueSuffix()}`, contractType: 'USED_PROPERTY_DELIVERY' }, tenant.userId, t);
    const { kd, body } = await entregaUsado(t);
    await assert.rejects(keyDeliveriesService.releaseKeyDelivery(kd.id, body, tenant.userId, t), (err) => err.code === 'LEGAL_USED_PROPERTY_TERM_MODEL_NOT_PUBLISHED');
    assert.equal((await keyDeliveriesService.getKeyDelivery(kd.id, t)).status, 'PENDING');
  });
});

test('linha 69: o banco só aceita publicação sem publicador para a versão 1 de origem CODE_SEED', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const tpl = await templateService.createTemplate({ ...base(), name: `Modelo ${uniqueSuffix()}`, contractType: 'USED_PROPERTY_DELIVERY' }, tenant.userId, t);
    const draft = await TemplateVersion.findOne({ where: { templateId: tpl.id, status: 'DRAFT' }, transaction: t })
      || await TemplateVersion.create({ ...base(), templateId: tpl.id, versionNumber: 1, status: 'DRAFT' }, { transaction: t });
    await assert.rejects(
      sequelize.query("UPDATE legal.template_versions SET status = 'PUBLISHED', published_at = now() WHERE id = :id", { replacements: { id: draft.id }, transaction: t }),
      /só vai de DRAFT para PUBLISHED/
    );
  });
});

test('linha 69: versão CODE_SEED forjada não publica sem publicador — sem cláusula, com cláusula de outro código ou com a TERMO_IMOVEL_USADO sem autor e outro texto', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const r = { g: tenant.groupId, c: tenant.companyId };
    const forjar = async (clausula) => {
      const tpl = await ContractTemplate.create({ ...base(), name: `Modelo forjado ${uniqueSuffix()}`, contractType: 'USED_PROPERTY_DELIVERY', isActive: true }, { transaction: t });
      const [[v]] = await sequelize.query(
        `INSERT INTO legal.template_versions (id, group_id, company_id, template_id, version_number, status, origin, created_at, updated_at)
         VALUES (gen_random_uuid(), :g, :c, :t, 1, 'DRAFT', 'CODE_SEED', now(), now()) RETURNING id`, { replacements: { ...r, t: tpl.id }, transaction: t });
      if (clausula) {
        // A cláusula aponta para a biblioteca do MESMO código (chave composta); a da semente pode já existir na empresa.
        const [[existente]] = await sequelize.query('SELECT id FROM legal.clause_library WHERE company_id = :c AND code = :code', { replacements: { ...r, code: clausula.code }, transaction: t });
        const [[lib]] = existente ? [[existente]] : await sequelize.query(`INSERT INTO legal.clause_library (id, group_id, company_id, code, created_at, updated_at)
          VALUES (gen_random_uuid(), :g, :c, :code, now(), now()) RETURNING id`, { replacements: { ...r, code: clausula.code }, transaction: t });
        const [[cv]] = await sequelize.query(`INSERT INTO legal.clause_versions (id, group_id, company_id, clause_library_id, code, title, body_text, category, version_number, is_active, created_at)
          VALUES (gen_random_uuid(), :g, :c, :lib, :code, 'Forjada', :body, 'GENERAL', 100 + floor(random() * 100000)::int, true, now()) RETURNING id`, { replacements: { ...r, lib: lib.id, code: clausula.code, body: clausula.body }, transaction: t });
        await sequelize.query(`INSERT INTO legal.contract_template_clauses (id, group_id, company_id, contract_template_id, contract_clause_id, template_version_id, sort_order, created_at)
          VALUES (gen_random_uuid(), :g, :c, :t, :cv, :v, 0, now())`, { replacements: { ...r, t: tpl.id, cv: cv.id, v: v.id }, transaction: t });
      }
      return v.id;
    };
    const casos = [null, { code: `OUTRA_CLAUSULA_${uniqueSuffix()}`, body: SEED.bodyText }, { code: SEED.clauseCode, body: 'Texto que ninguém aprovou.' }];
    for (const clausula of casos) {
      const id = await forjar(clausula);
      await q(t, 'SAVEPOINT forjada');
      await assert.rejects(
        sequelize.query("UPDATE legal.template_versions SET status = 'PUBLISHED', published_at = now() WHERE id = :id", { replacements: { id }, transaction: t }),
        /só vai de DRAFT para PUBLISHED/, JSON.stringify(clausula)
      );
      await q(t, 'ROLLBACK TO SAVEPOINT forjada');
    }
  });
});
