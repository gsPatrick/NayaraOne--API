'use strict';

// Matriz de fechamento do Marco 5 (Contratos) — rotas literais do Guia §14 (APIs mínimas) e o envio da
// versão vigente para assinatura. HTTP real, dois tenants do seed de CI, RLS real.
process.env.PORT = process.env.M5FECH_CT_PORT || '5534';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./m5fech.contratos.helpers');

let pular = null;
before(async () => { pular = await h.pronto(); });
after(h.encerrar);

test('Guia §14: POST /contracts e POST /contracts/:id/versions criam contrato e versão pelo mesmo serviço (permissão e hash do servidor)', async (t) => {
  if (pular) return t.skip(pular);
  const negado = await h.http('A:leitura', 'POST', '/contracts', { contractType: 'SALE_CASH' });
  assert.equal(negado.status, 403);
  assert.equal(negado.code, 'PERMISSION_DENIED');
  const c = await h.http('A:maker', 'POST', '/contracts', { contractType: 'SALE_CASH', totalValue: 250000 });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.data.status, 'DRAFT');
  assert.match(c.data.contractNumber, /^VEN-\d{4}-\d{4}$/);
  const [criado] = await h.eventos('A:maker', c.data.id, 'contract.created');
  assert.ok(criado, 'contract.created publicado pela rota literal');
  const f = await h.arquivo('A:maker');
  const conteudo = `Contrato fictício ${h.sfx()}`;
  const v = await h.http('A:maker', 'POST', `/contracts/${c.data.id}/versions`, { content: conteudo, documentFileId: f });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.equal(v.data.versionNumber, 1);
  assert.equal(v.data.contentHash, require('node:crypto').createHash('sha256').update(conteudo).digest('hex'));
  const outro = await h.http('B:gestor', 'POST', `/contracts/${c.data.id}/versions`, { content: 'x', documentFileId: f });
  assert.equal(outro.status, 404, 'tenant B não cria versão no contrato de A');
});

test('Guia §14: POST /contract-versions/:id/approve aprova só a versão vigente, com legal:approve, auditoria e contract.version.approved', async (t) => {
  if (pular) return t.skip(pular);
  const c = await h.contratoEmRevisao('A:gestor');
  const semPermissao = await h.http('A:maker', 'POST', `/contract-versions/${c.versionId}/approve`, {});
  assert.equal(semPermissao.status, 403);
  assert.equal(semPermissao.code, 'PERMISSION_DENIED');
  const outroTenant = await h.http('B:checker', 'POST', `/contract-versions/${c.versionId}/approve`, {});
  assert.equal(outroTenant.status, 404);
  const f2 = await h.arquivo('A:gestor');
  const v2 = await h.http('A:gestor', 'POST', `/legal/contracts/${c.contractId}/versions`, { content: `Versão 2 ${h.sfx()}`, documentFileId: f2 });
  assert.equal(v2.status, 201);
  const antiga = await h.http('A:checker', 'POST', `/contract-versions/${c.versionId}/approve`, {});
  assert.equal(antiga.status, 409);
  assert.equal(antiga.code, 'LEGAL_CONTRACT_VERSION_SUPERSEDED');
  const ok = await h.http('A:checker', 'POST', `/contract-versions/${v2.data.id}/approve`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.data.contract.status, 'APPROVED');
  assert.equal(ok.data.contractVersionId, v2.data.id);
  const [ev] = await h.eventos('A:checker', c.contractId, 'contract.version.approved');
  assert.equal(ev.payload_json.contractVersionId, v2.data.id);
  assert.equal(ev.payload_json.contentHash, v2.data.contentHash);
  const [aud] = await h.sql('A:checker', "SELECT user_id FROM audit.audit_log WHERE entity_id = :id AND action = 'legal.contract.status_change' AND after_json->>'status' = 'APPROVED'", { id: c.contractId });
  assert.equal(aud.user_id, h.tenantOf('A:checker').userId, 'aprovação auditada com o aprovador');
  const deNovo = await h.http('A:checker', 'POST', `/contract-versions/${v2.data.id}/approve`, {});
  assert.equal(deNovo.status, 409, 'aprovar de novo não repete efeito');
});

test('Guia §14: POST /contract-versions/:id/send-signature exige versão vigente de contrato APPROVED e cria as assinaturas presas à versão e ao hash', async (t) => {
  if (pular) return t.skip(pular);
  const c = await h.contratoEmRevisao('A:gestor');
  const cedo = await h.http('A:gestor', 'POST', `/contract-versions/${c.versionId}/send-signature`, { signerPersonIds: [c.landlord, c.tenantPerson] });
  assert.equal(cedo.status, 409);
  assert.equal(cedo.code, 'LEGAL_SIGNATURE_VERSION_NOT_APPROVED');
  assert.equal((await h.http('A:gestor', 'POST', `/contract-versions/${c.versionId}/approve`, {})).status, 200);
  const semSign = await h.http('A:checker', 'POST', `/contract-versions/${c.versionId}/send-signature`, { signerPersonIds: [c.landlord] });
  assert.equal(semSign.status, 403, 'enviar exige legal:sign');
  const vazio = await h.http('A:gestor', 'POST', `/contract-versions/${c.versionId}/send-signature`, { signerPersonIds: [] });
  assert.equal(vazio.code, 'LEGAL_SIGNATURE_VALIDATION');
  const ok = await h.http('A:gestor', 'POST', `/contract-versions/${c.versionId}/send-signature`, { signerPersonIds: [c.landlord, c.tenantPerson] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const [{ status }] = await h.sql('A:gestor', 'SELECT status FROM legal.contracts WHERE id = :id', { id: c.contractId });
  assert.equal(status, 'SIGNING');
  const sigs = await h.sql('A:gestor', 'SELECT person_id, contract_version_id, content_hash, status FROM legal.signatures WHERE contract_version_id = :v ORDER BY created_at', { v: c.versionId });
  assert.equal(sigs.length, 2);
  for (const s of sigs) {
    assert.equal(s.contract_version_id, c.versionId);
    assert.equal(s.content_hash, c.contentHash, 'assinatura presa ao hash da versão');
    assert.equal(s.status, 'PENDING');
  }
  assert.deepEqual(sigs.map((s) => s.person_id).sort(), [c.landlord, c.tenantPerson].sort());
  const [ev] = await h.eventos('A:gestor', c.contractId, 'contract.sent_for_signature');
  assert.equal(ev.payload_json.contractVersionId, c.versionId);
  const repetido = await h.http('A:gestor', 'POST', `/contract-versions/${c.versionId}/send-signature`, { signerPersonIds: [c.landlord] });
  assert.equal(repetido.code, 'LEGAL_SIGNATURE_VERSION_NOT_APPROVED', 'contrato já em SIGNING não é reenviado pela rota do livro');
});
