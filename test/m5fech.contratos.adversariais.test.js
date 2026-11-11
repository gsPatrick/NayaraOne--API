'use strict';

// Matriz de fechamento do Marco 5 (Contratos) — testes adversariais do Caderno §20 por HTTP real:
// JUR-TS-002 (hash diferente), JUR-TS-007 (webhook duplicado), JUR-TS-013 (documento da empresa B)
// e JUR-TS-014 (aditivo tentando sobrescrever o contrato). Dois tenants do seed de CI, RLS real.
process.env.PORT = process.env.M5FECH_CT_PORT || '5534';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./m5fech.contratos.helpers');

let pular = null;
before(async () => { pular = await h.pronto(); });
after(h.encerrar);

/** Contrato aprovado e enviado (sandbox) pelas rotas do livro; devolve também as assinaturas. */
async function emAssinatura() {
  const c = await h.contratoEmRevisao('A:gestor');
  assert.equal((await h.http('A:gestor', 'POST', `/contract-versions/${c.versionId}/approve`, {})).status, 200);
  const env = await h.http('A:gestor', 'POST', `/contract-versions/${c.versionId}/send-signature`, { signerPersonIds: [c.landlord, c.tenantPerson] });
  assert.equal(env.status, 201, JSON.stringify(env.body));
  const sigs = await h.sql('A:gestor', 'SELECT id, person_id, external_signature_id, status FROM legal.signatures WHERE contract_version_id = :v ORDER BY created_at', { v: c.versionId });
  assert.ok(sigs.every((s) => s.external_signature_id), 'cada signatário tem o id do fornecedor');
  return { ...c, sigs };
}
const statusDe = async (id) => (await h.sql('A:gestor', 'SELECT status FROM legal.contracts WHERE id = :id', { id }))[0].status;

test('JUR-TS-002: assinatura que aponta hash diferente da versão é rejeitada e o contrato continua em SIGNING', async (t) => {
  if (pular) return t.skip(pular);
  const c = await emAssinatura();
  const errado = await h.http('A:gestor', 'POST', `/legal/signatures/${c.sigs[0].external_signature_id}/webhook`, { contentHash: 'ab'.repeat(32) });
  assert.equal(errado.status, 409);
  assert.equal(errado.code, 'LEGAL_SIGNATURE_HASH_MISMATCH');
  const [s] = await h.sql('A:gestor', 'SELECT status FROM legal.signatures WHERE id = :id', { id: c.sigs[0].id });
  assert.equal(s.status, 'PENDING');
  assert.equal(await statusDe(c.contractId), 'SIGNING');
  const semHash = await h.http('A:gestor', 'POST', `/legal/signatures/${c.sigs[0].external_signature_id}/webhook`, {});
  assert.equal(semHash.code, 'LEGAL_WEBHOOK_HASH_REQUIRED', 'sem o hash do documento assinado o webhook do sandbox é recusado');
});

test('JUR-TS-007: webhook de assinatura duplicado (mesmo id externo) gera uma única atualização, e SIGNED só com todas as assinaturas da versão', async (t) => {
  if (pular) return t.skip(pular);
  const c = await emAssinatura();
  const [a, b] = c.sigs;
  const r1 = await h.http('A:gestor', 'POST', `/legal/signatures/${a.external_signature_id}/webhook`, { contentHash: c.contentHash });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.data.alreadyProcessed, false);
  assert.equal(await statusDe(c.contractId), 'SIGNING', 'uma de duas assinaturas não leva a SIGNED');
  const r2 = await h.http('A:gestor', 'POST', `/legal/signatures/${a.external_signature_id}/webhook`, { contentHash: c.contentHash });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.alreadyProcessed, true);
  const [{ n: audits }] = await h.sql('A:gestor', "SELECT COUNT(*)::int AS n FROM audit.audit_log WHERE entity_id = :id AND action = 'legal.signature.signed'", { id: a.id });
  assert.equal(audits, 1, 'uma única auditoria de assinatura');
  const [{ n: evs }] = await h.sql('A:gestor', "SELECT COUNT(*)::int AS n FROM integration.outbox_events WHERE aggregate_id = :id AND event_type = 'legal.signature.signed'", { id: a.id });
  assert.equal(evs, 1, 'um único evento de assinatura');
  const r3 = await h.http('A:gestor', 'POST', `/legal/signatures/${b.external_signature_id}/webhook`, { contentHash: c.contentHash });
  assert.equal(r3.status, 200);
  assert.equal(r3.data.contractTransitioned, true);
  assert.equal(await statusDe(c.contractId), 'SIGNED');
  const [ev] = await h.eventos('A:gestor', c.contractId, 'contract.signed');
  assert.equal(ev.payload_json.contractVersionId, c.versionId);
  assert.equal(ev.payload_json.contentHash, c.contentHash);
});

test('JUR-TS-013: documento da empresa B é bloqueado na versão, no checklist e no aditivo da empresa A, e B não lê o contrato de A', async (t) => {
  if (pular) return t.skip(pular);
  const c = await h.contratoEmRevisao('A:gestor');
  const fileB = await h.arquivo('B:gestor', 'documento-empresa-b.pdf');
  const versao = await h.http('A:gestor', 'POST', `/legal/contracts/${c.contractId}/versions`, { content: `Versão com arquivo de B ${h.sfx()}`, documentFileId: fileB });
  assert.equal(versao.status, 404);
  assert.equal(versao.code, 'LEGAL_CONTRACT_VERSION_FILE_NOT_FOUND');
  const [req] = await h.sql('A:gestor', 'SELECT id FROM legal.contract_requirements WHERE contract_id = :id ORDER BY created_at LIMIT 1', { id: c.contractId });
  const exigencia = await h.http('A:gestor', 'PATCH', `/legal/requirements/${req.id}`, { satisfiedByFileId: fileB });
  assert.equal(exigencia.status, 404);
  assert.equal(exigencia.code, 'LEGAL_REQUIREMENT_FILE_NOT_FOUND');
  const aditivo = await h.http('A:gestor', 'POST', `/legal/contracts/${c.contractId}/amendments`, { reason: 'Aditivo com arquivo de B', changes: [{ field: 'totalValue', oldValue: 1500, newValue: 1600 }], documentFileId: fileB });
  assert.equal(aditivo.code, 'LEGAL_CONTRACT_AMENDMENT_FILE_NOT_FOUND');
  const versoes = await h.sql('A:gestor', 'SELECT id FROM legal.contract_versions WHERE contract_id = :id', { id: c.contractId });
  assert.equal(versoes.length, 1, 'nada foi gravado com o arquivo de B');
  const leituraB = await h.http('B:gestor', 'GET', `/legal/contracts/${c.contractId}`);
  assert.equal(leituraB.status, 404, 'empresa B não lê o contrato de A');
  const visto = await h.sql('B:gestor', 'SELECT id FROM legal.contracts WHERE id = :id', { id: c.contractId });
  assert.equal(visto.length, 0, 'RLS: o contrato de A não existe para B');
});

test('JUR-TS-014: aditivo não sobrescreve o contrato — cabeçalho, versões e hash intactos; versão não tem rota de edição e o banco recusa UPDATE', async (t) => {
  if (pular) return t.skip(pular);
  const c = await h.contratoEmRevisao('A:gestor');
  const antes = await h.sql('A:gestor', 'SELECT c.total_value, c.status, v.id AS vid, v.content_hash, v.content FROM legal.contracts c JOIN legal.contract_versions v ON v.contract_id = c.id WHERE c.id = :id', { id: c.contractId });
  const ad = await h.http('A:gestor', 'POST', `/legal/contracts/${c.contractId}/amendments`, { reason: 'Reajuste fictício', changes: [{ field: 'totalValue', oldValue: 1500, newValue: 9999 }, { field: 'content', newValue: 'texto sobrescrito' }] });
  assert.equal(ad.status, 201, JSON.stringify(ad.body));
  assert.equal(ad.data.contractId, c.contractId);
  assert.equal(ad.data.amendmentNumber, 1);
  const depois = await h.sql('A:gestor', 'SELECT c.total_value, c.status, v.id AS vid, v.content_hash, v.content FROM legal.contracts c JOIN legal.contract_versions v ON v.contract_id = c.id WHERE c.id = :id', { id: c.contractId });
  assert.deepEqual(depois, antes, 'o aditivo registra a alteração, não reescreve contrato nem versão');
  const patch = await h.http('A:gestor', 'PATCH', `/legal/contract-versions/${c.versionId}`, { content: 'adulterado' });
  assert.equal(patch.status, 404, 'não existe rota de edição de versão');
  await assert.rejects(
    h.comTenant('A:gestor', (tx) => require('../src/models').sequelize.query("UPDATE legal.contract_versions SET content = 'adulterado', content_hash = repeat('0', 64) WHERE id = :id", { replacements: { id: c.versionId }, transaction: tx })),
    /append-only|imutáv|não pode/i,
    'o banco recusa reescrever a versão'
  );
  const outro = await h.http('B:gestor', 'POST', `/legal/contracts/${c.contractId}/amendments`, { reason: 'x', changes: [{ field: 'totalValue', newValue: 1 }] });
  assert.equal(outro.status, 404, 'empresa B não cria aditivo no contrato de A');
});
