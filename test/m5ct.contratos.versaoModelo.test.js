'use strict';

// Verificação independente do Marco 5:
//  - linha 63 (Caderno §6 "Versão gerada do contrato guarda template_version_id, clause_version_ids e conteúdo/hash final");
//  - linha 123 (Caderno §17 "Compara versões/cláusulas"): a comparação aponta as cláusulas incluídas e excluídas entre versões.
// Serviço real, transação desfeita no fim.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const contractsService = require('../src/modules/legal/contracts/application/contract.service');
const contractVersionsService = require('../src/modules/legal/contracts/application/contractVersions.service');
const templateService = require('../src/modules/legal/contracts/application/template.service');
const clausesService = require('../src/modules/legal/contracts/application/contractClauses.service');
const nay = require('../src/modules/legal/cases/legalNay.service');
const juridicaData = require('../src/features/ai/agents/nay_juridica/juridica.data');
const { ContractVersion, TemplateVersion, File } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });
const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

async function cenario(t) {
  const sfx = uniqueSuffix();
  const mk = (code, title, bodyText) => clausesService.createClause({ ...base(), code: `${code}-${sfx}`, title, bodyText, category: 'GENERAL' }, tenant.userId, t);
  const a = await mk('M5CT-OBJ', 'DO OBJETO', `Objeto da locação ${sfx}.`);
  const b = await mk('M5CT-FORO', 'DO FORO', `Fica eleito o foro ${sfx}.`);
  const tpl = await templateService.createTemplate({ ...base(), contractType: 'LEASE_RESIDENTIAL', name: `Modelo M5CT ${sfx}` }, tenant.userId, t);
  await templateService.addClauseToTemplate(tpl.id, { contractClauseId: a.id, sortOrder: 1 }, tenant.userId, t);
  await templateService.addClauseToTemplate(tpl.id, { contractClauseId: b.id, sortOrder: 2 }, tenant.userId, t);
  const tv1 = await templateService.publishTemplate(tpl.id, tenant.userId, t);
  const c = await contractsService.createContract({ ...base(), contractType: 'LEASE_RESIDENTIAL', totalValue: 1000 }, tenant.userId, t);
  for (const role of ['LANDLORD', 'TENANT']) {
    const p = await peopleService.createPerson({ ...base(), personType: 'PF', legalName: `M5CT ${role} ${sfx}` }, tenant.userId, t);
    await contractsService.addContractParty(c.id, { personId: p.id, partyRole: role }, tenant.userId, t);
  }
  return { a, b, tpl, tv1, c, sfx };
}
const gerar = (t, contractId, templateId) => contractVersionsService.createContractVersion(contractId, { requireDocument: false, templateId }, tenant.userId, t);

test('linha 63 §6: a versão gerada pelo modelo guarda template_version_id, clause_version_ids (versão exata de cada cláusula) e o hash do conteúdo final', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { a, b, tpl, tv1, c } = await cenario(t);
    const v = await gerar(t, c.id, tpl.id);
    const gravada = await ContractVersion.findByPk(v.id, { transaction: t });
    assert.equal(gravada.templateVersionId, tv1.id, 'template_version_id = versão PUBLICADA usada');
    assert.deepEqual(gravada.clauseVersionIds, [
      { contractClauseId: a.id, code: a.code, versionNumber: 1 },
      { contractClauseId: b.id, code: b.code, versionNumber: 1 },
    ], 'clause_version_ids = cada versão de cláusula, na ordem do modelo');
    assert.ok(gravada.content.includes(a.bodyText) && gravada.content.includes(b.bodyText));
    assert.equal(gravada.contentHash, sha(gravada.content), 'hash final = SHA-256 dos bytes do conteúdo gravado');
    const arquivo = await File.findByPk(gravada.contentFileId, { transaction: t });
    assert.equal(arquivo.checksumSha256, gravada.contentHash, 'o arquivo armazenado da versão tem o mesmo hash');
    // Imutável no banco: clause_version_ids e hash não são reescritos.
    await sequelize.query('SAVEPOINT m5ct_63', { transaction: t });
    await assert.rejects(sequelize.query("UPDATE legal.contract_versions SET clause_version_ids = '[]'::jsonb WHERE id = :id", { replacements: { id: v.id }, transaction: t }));
    await sequelize.query('ROLLBACK TO SAVEPOINT m5ct_63', { transaction: t });
    await assert.rejects(sequelize.query("UPDATE legal.contract_versions SET content_hash = repeat('0', 64) WHERE id = :id", { replacements: { id: v.id }, transaction: t }));
  });
});

test('linha 123 §17: comparar versões aponta cláusulas incluídas e excluídas (versão nova de cláusula = a antiga sai, a nova entra) e as linhas', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { a, b, tpl, c, sfx } = await cenario(t);
    const v1 = await gerar(t, c.id, tpl.id);
    // O jurídico troca o texto do foro (versão 2 da cláusula), inclui uma cláusula nova e publica a versão 2 do modelo.
    const b2 = await clausesService.createClauseVersion(b.code, { bodyText: `Fica eleito o foro da capital ${sfx}.` }, tenant.userId, t);
    await templateService.upgradeTemplateClause(tpl.id, b.id, tenant.userId, t);
    const novo = await clausesService.createClause({ ...base(), code: `M5CT-MULTA-${sfx}`, title: 'DA MULTA', bodyText: `Multa de 10% ${sfx}.`, category: 'PENALTY' }, tenant.userId, t);
    await templateService.addClauseToTemplate(tpl.id, { contractClauseId: novo.id, sortOrder: 3 }, tenant.userId, t);
    await templateService.publishTemplate(tpl.id, tenant.userId, t);
    const v2 = await gerar(t, c.id, tpl.id);

    const r = await nay.compareContractVersions(base(), c.id, v1.versionNumber, v2.versionNumber, tenant.userId, t);
    assert.deepEqual(r.clausulasIncluidas.map((x) => [x.id, x.codigo, x.versao]), [[b2.id, b.code, 2], [novo.id, novo.code, 1]]);
    assert.deepEqual(r.clausulasExcluidas.map((x) => [x.id, x.codigo, x.versao]), [[b.id, b.code, 1]]);
    assert.ok(!r.clausulasIncluidas.some((x) => x.id === a.id) && !r.clausulasExcluidas.some((x) => x.id === a.id), 'cláusula igual nas duas não aparece');
    assert.ok(r.linhasIncluidas.some((l) => l.includes('foro da capital')));
    assert.equal(r.hashIgual, false);

    // A NAY Jurídica da camada de IA (tool legal.compareVersions) usa a mesma leitura das cláusulas.
    const m9 = await juridicaData.compareVersions(c.id, v1.versionNumber, v2.versionNumber, t);
    assert.deepEqual(m9.clausesAdded.map((x) => x.id), [b2.id, novo.id]);
    assert.deepEqual(m9.clausesRemoved.map((x) => x.id), [b.id]);

    // Mesma versão de cláusula nas duas = nada incluído nem excluído.
    const v3 = await gerar(t, c.id, tpl.id);
    const igual = await nay.compareContractVersions(base(), c.id, v2.versionNumber, v3.versionNumber, tenant.userId, t);
    assert.deepEqual([igual.clausulasIncluidas, igual.clausulasExcluidas], [[], []]);
    assert.ok(await TemplateVersion.count({ where: { templateId: tpl.id }, transaction: t }) >= 2);
  });
});
