'use strict';

// Matriz de fechamento do Marco 5 (Contratos), segunda onda — aprovação POR VERSÃO (Guia §6, Caderno §19), versão
// imutável e arquivo armazenado com os bytes do hash (Guia §4), JUR-001 (contrato aprovado/assinado não é
// sobrescrito). HTTP real com os perfis do seed de dois tenants; RLS real.
process.env.PORT = process.env.M5FECH_CT_PORT || '5534';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./m5fech.contratos.helpers');
const { sequelize } = require('../src/models');

let pular = null;
before(async () => { pular = await h.pronto(); });
after(h.encerrar);

const versao = async (id) => (await h.sql('A:gestor', 'SELECT id, status, approved_by, approved_at, content_hash, content_file_id FROM legal.contract_versions WHERE id = :id', { id }))[0];
const contrato = async (id) => (await h.sql('A:gestor', 'SELECT status, approved_version_id, total_value::text AS total FROM legal.contracts WHERE id = :id', { id }))[0];

test('Guia §6: aprovação é da versão — versão nova depois da aprovação nasce DRAFT, não vai para assinatura e exige nova aprovação', async (t) => {
  if (pular) return t.skip(pular);
  const c = await h.contratoEmRevisao('A:gestor');
  assert.equal((await versao(c.versionId)).status, 'DRAFT');
  assert.equal((await h.http('A:checker', 'POST', `/contract-versions/${c.versionId}/approve`, {})).status, 200);
  const v1 = await versao(c.versionId);
  assert.equal(v1.status, 'APPROVED');
  assert.equal(v1.approved_by, h.tenantOf('A:checker').userId);
  assert.equal((await contrato(c.contractId)).approved_version_id, c.versionId);

  const f2 = await h.arquivo('A:gestor');
  const v2 = await h.http('A:gestor', 'POST', `/contracts/${c.contractId}/versions`, { content: `Versão 2 ${h.sfx()}`, documentFileId: f2 });
  assert.equal(v2.status, 201);
  assert.equal(v2.data.status, 'DRAFT');
  assert.equal((await versao(c.versionId)).status, 'SUPERSEDED', 'a versão aprovada anterior fica substituída');
  const semAprovar = await h.http('A:gestor', 'POST', `/contract-versions/${v2.data.id}/send-signature`, { signerPersonIds: [c.landlord, c.tenantPerson] });
  assert.equal(semAprovar.status, 409);
  assert.equal(semAprovar.code, 'LEGAL_SIGNATURE_VERSION_NOT_APPROVED');
  const transicao = await h.http('A:checker', 'POST', `/legal/contracts/${c.contractId}/transition`, { targetStatus: 'SIGNING' });
  assert.equal(transicao.code, 'LEGAL_SIGNATURE_VERSION_NOT_APPROVED', 'a transição genérica também exige a versão aprovada');
  const aprova = await h.http('A:checker', 'POST', `/contract-versions/${v2.data.id}/approve`, {});
  assert.equal(aprova.status, 200, JSON.stringify(aprova.body));
  assert.equal((await contrato(c.contractId)).approved_version_id, v2.data.id);
  const evs = await h.eventos('A:gestor', c.contractId, 'contract.version.approved');
  assert.deepEqual(evs.map((e) => e.payload_json.contractVersionId), [c.versionId, v2.data.id]);
  const envia = await h.http('A:gestor', 'POST', `/contract-versions/${v2.data.id}/send-signature`, { signerPersonIds: [c.landlord, c.tenantPerson] });
  assert.equal(envia.status, 201, JSON.stringify(envia.body));
});

test('Guia §4: hash do arquivo armazenado — a versão guarda os bytes; arquivo adulterado no armazenamento impede a aprovação', async (t) => {
  if (pular) return t.skip(pular);
  const c = await h.contratoEmRevisao('A:gestor');
  const v = await versao(c.versionId);
  const [file] = await h.sql('A:gestor', 'SELECT storage_key, checksum_sha256 FROM people.files WHERE id = :id', { id: v.content_file_id });
  assert.equal(file.checksum_sha256, v.content_hash, 'o hash da versão é o dos bytes armazenados');
  const caminho = path.join(require('../src/utils/diskStorage').UPLOADS_ROOT, file.storage_key);
  fs.writeFileSync(caminho, require('../src/utils/fileCrypto').encryptFileBuffer(Buffer.from('conteúdo adulterado no armazenamento')));
  const r = await h.http('A:checker', 'POST', `/contract-versions/${c.versionId}/approve`, {});
  assert.equal(r.status, 409);
  assert.equal(r.code, 'LEGAL_CONTRACT_VERSION_HASH_MISMATCH');
  assert.equal((await versao(c.versionId)).status, 'DRAFT');
});

test('Guia §4 assertEditableState: contrato assinado não recebe versão e o banco recusa reverter/forjar a aprovação da versão', async (t) => {
  if (pular) return t.skip(pular);
  const c = await h.contratoEmRevisao('A:gestor');
  assert.equal((await h.http('A:checker', 'POST', `/contract-versions/${c.versionId}/approve`, {})).status, 200);
  await assert.rejects(
    h.comTenant('A:gestor', (tx) => sequelize.query("UPDATE legal.contract_versions SET status = 'DRAFT' WHERE id = :id", { replacements: { id: c.versionId }, transaction: tx })),
    /só pode ir de DRAFT para APPROVED/,
    'APPROVED não volta para DRAFT'
  );
  await assert.rejects(
    h.comTenant('A:gestor', (tx) => sequelize.query('UPDATE legal.contract_versions SET approved_by = NULL WHERE id = :id', { replacements: { id: c.versionId }, transaction: tx })),
    /só pode ir de DRAFT para APPROVED/,
    'o aprovador não é trocado'
  );
  await h.comTenant('A:gestor', (tx) => sequelize.query("UPDATE legal.contracts SET status = 'SIGNED' WHERE id = :id", { replacements: { id: c.contractId }, transaction: tx }));
  const f = await h.arquivo('A:gestor');
  const nova = await h.http('A:gestor', 'POST', `/contracts/${c.contractId}/versions`, { content: 'Tentativa de reescrever o assinado', documentFileId: f });
  assert.equal(nova.status, 409);
  assert.equal(nova.code, 'LEGAL_CONTRACT_VERSION_NOT_EDITABLE');
});

test('JUR-001: a partir de APPROVED valor, vigência, imóvel e número não são reescritos — a correção é por aditivo', async (t) => {
  if (pular) return t.skip(pular);
  const contractsService = require('../src/modules/legal/contracts/application/contract.service');
  const c = await h.contratoEmRevisao('A:gestor');
  const mfa = await h.http('A:gestor', 'PATCH', `/legal/contracts/${c.contractId}/correct`, { reason: 'tentativa', totalValue: 9999 });
  assert.equal(mfa.code, 'MFA_REQUIRED_NOT_ENABLED', 'a rota de correção continua exigindo MFA');
  const antes = await h.comTenant('A:gestor', (tx, tn) => contractsService.correctContractData(c.contractId, { totalValue: 1600, reason: 'correção em revisão' }, tn.userId, tx));
  assert.equal(Number(antes.totalValue), 1600, 'antes da aprovação a correção auditada continua valendo');
  assert.equal((await h.http('A:checker', 'POST', `/contract-versions/${c.versionId}/approve`, {})).status, 200);
  for (const campo of [{ totalValue: 9999 }, { endsAt: '2031-01-01' }, { startsAt: '2026-01-01' }, { contractNumber: 'X-1' }]) {
    await assert.rejects(
      h.comTenant('A:gestor', (tx, tn) => contractsService.correctContractData(c.contractId, { ...campo, reason: 'tentativa depois da aprovação' }, tn.userId, tx)),
      (err) => err.code === 'LEGAL_CONTRACT_TERMS_LOCKED_USE_ADDENDUM',
      JSON.stringify(campo)
    );
  }
  assert.equal((await contrato(c.contractId)).total, '1600.00');
  const ad = await h.http('A:gestor', 'POST', `/legal/contracts/${c.contractId}/amendments`, { reason: 'Reajuste por aditivo', changes: [{ field: 'totalValue', oldValue: 1600, newValue: 9999 }] });
  assert.equal(ad.status, 201, 'a alteração é registrada por aditivo');
  assert.equal((await contrato(c.contractId)).total, '1600.00', 'o aditivo não reescreve o contrato');
});
