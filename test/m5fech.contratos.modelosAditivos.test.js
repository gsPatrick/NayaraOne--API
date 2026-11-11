'use strict';

// Matriz de fechamento do Marco 5 (Contratos), segunda onda — modelo versionado e biblioteca de cláusulas
// (Caderno §4/§6, JUR-002), checklist pelo Motor de Regras (Caderno §7, Guia §20) e aditivos (Caderno §13).
process.env.PORT = process.env.M5FECH_CT_PORT || '5534';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./m5fech.contratos.helpers');
const { sequelize } = require('../src/models');

let pular = null;
before(async () => { pular = await h.pronto(); });
after(h.encerrar);

test('§6/JUR-002: só modelo PUBLICADO gera contrato, publicado não é editado — nova versão é criada; a versão do contrato guarda template_version_id; responsável jurídico no modelo e na cláusula', async (t) => {
  if (pular) return t.skip(pular);
  const code = `MT-${h.sfx()}`;
  const cl = await h.http('A:maker', 'POST', '/legal/clauses', { code, title: 'Multa', bodyText: 'Multa fictícia.', category: 'PENALTY' });
  assert.equal(cl.status, 201);
  const [lib] = await h.sql('A:gestor', 'SELECT l.legal_responsible_user_id, v.clause_library_id = l.id AS ligada FROM legal.clause_library l JOIN legal.clause_versions v ON v.clause_library_id = l.id WHERE l.code = :code', { code });
  assert.deepEqual(lib, { legal_responsible_user_id: h.tenantOf('A:maker').userId, ligada: true });
  const tpl = await h.http('A:maker', 'POST', '/legal/contract-templates', { name: `Modelo ${code}`, contractType: 'LEASE_RESIDENTIAL' });
  assert.equal(tpl.data.legalResponsibleUserId, h.tenantOf('A:maker').userId);
  await h.http('A:maker', 'POST', `/legal/contract-templates/${tpl.data.id}/clauses`, { contractClauseId: cl.data.id });
  const ct = await h.http('A:gestor', 'POST', '/contracts', { contractType: 'LEASE_RESIDENTIAL', totalValue: 1000 });
  const f = await h.arquivo('A:gestor');
  const versoes = async () => (await h.http('A:leitura', 'GET', `/legal/contract-templates/${tpl.data.id}/versions`)).data.map((x) => [x.versionNumber, x.status]);
  const rascunho = await h.http('A:gestor', 'POST', `/contracts/${ct.data.id}/versions`, { templateId: tpl.data.id, documentFileId: f });
  assert.equal(rascunho.status, 409, 'modelo só em rascunho não gera contrato');
  assert.equal(rascunho.code, 'LEGAL_TEMPLATE_NOT_PUBLISHED');
  assert.deepEqual(await versoes(), [[1, 'DRAFT']], 'gerar não publica o modelo');
  assert.equal((await h.http('A:maker', 'POST', `/legal/contract-templates/${tpl.data.id}/publish`, {})).status, 403, 'publicar exige legal:approve');
  assert.equal((await h.http('A:checker', 'POST', `/legal/contract-templates/${tpl.data.id}/publish`, {})).status, 200);
  const v = await h.http('A:gestor', 'POST', `/contracts/${ct.data.id}/versions`, { templateId: tpl.data.id, documentFileId: f });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.deepEqual(await versoes(), [[1, 'PUBLISHED']]);
  const [cv] = await h.sql('A:gestor', 'SELECT template_version_id FROM legal.contract_versions WHERE id = :id', { id: v.data.id });
  const [tv1] = await h.sql('A:gestor', 'SELECT id FROM legal.template_versions WHERE template_id = :t AND version_number = 1', { t: tpl.data.id });
  assert.equal(cv.template_version_id, tv1.id);
  await assert.rejects(
    h.comTenant('A:gestor', (tx) => sequelize.query('DELETE FROM legal.contract_template_clauses WHERE template_version_id = :v', { replacements: { v: tv1.id }, transaction: tx })),
    /versão publicada do modelo não é editada/,
    'o banco recusa mexer nos vínculos da versão publicada'
  );
  const cl2 = await h.http('A:maker', 'POST', '/legal/clauses', { code: `${code}-B`, title: 'Foro', bodyText: 'Foro fictício.', category: 'GENERAL' });
  assert.equal((await h.http('A:maker', 'POST', `/legal/contract-templates/${tpl.data.id}/clauses`, { contractClauseId: cl2.data.id })).status, 201);
  assert.deepEqual(await versoes(), [[1, 'PUBLISHED'], [2, 'DRAFT']], 'mexer no modelo publicado cria a versão 2');
  const ct2 = await h.http('A:gestor', 'POST', '/contracts', { contractType: 'LEASE_RESIDENTIAL', totalValue: 1000 });
  const v2c = await h.http('A:gestor', 'POST', `/contracts/${ct2.data.id}/versions`, { templateId: tpl.data.id, documentFileId: await h.arquivo('A:gestor') });
  assert.equal(v2c.status, 201);
  const [usa] = await h.sql('A:gestor', 'SELECT template_version_id FROM legal.contract_versions WHERE id = :id', { id: v2c.data.id });
  assert.equal(usa.template_version_id, tv1.id, 'com rascunho em edição, a geração usa a versão publicada, nunca o rascunho');
  const det = await h.http('A:leitura', 'GET', `/legal/contract-templates/${tpl.data.id}`);
  assert.deepEqual(det.data.versions.map((x) => [x.versionNumber, x.status, x.clauses.length]), [[1, 'PUBLISHED', 1], [2, 'DRAFT', 2]], 'o modelo vem com versões e cláusulas');
  assert.equal(det.data.legalResponsible.id, h.tenantOf('A:maker').userId);
  assert.equal(det.data.publishedVersion.versionNumber, 1);
  const lista = await h.http('A:leitura', 'GET', `/legal/clauses?code=${encodeURIComponent(code)}`);
  assert.equal(lista.data[0].legalResponsible.id, h.tenantOf('A:maker').userId, 'a lista de cláusulas traz o responsável jurídico');
  assert.ok(lista.data[0].legalResponsible.name);
  const [n1] = await h.sql('A:gestor', 'SELECT count(*)::int AS n FROM legal.contract_template_clauses WHERE template_version_id = :v', { v: tv1.id });
  assert.equal(n1.n, 1, 'a versão 1 continua com a cláusula que tinha');
  assert.equal((await h.http('A:maker', 'POST', `/legal/contract-templates/${tpl.data.id}/publish`, {})).status, 403, 'publicar exige legal:approve');
  assert.equal((await h.http('A:checker', 'POST', `/legal/contract-templates/${tpl.data.id}/publish`, {})).status, 200);
  assert.deepEqual(await versoes(), [[1, 'SUPERSEDED'], [2, 'PUBLISHED']]);
  const [old] = await h.sql('A:gestor', "SELECT to_regclass('legal.contract_clauses') AS antiga, to_regclass('legal.clause_versions') AS versoes, to_regclass('legal.template_versions') AS modelos");
  assert.deepEqual(old, { antiga: null, versoes: 'legal.clause_versions', modelos: 'legal.template_versions' });
});

test('§7/Guia §20: checklist pelo Motor de Regras (REG-JUR-001) com as características das partes — PJ e parte representada mudam a lista; nova versão da regra muda a lista', async (t) => {
  if (pular) return t.skip(pular);
  const { DEFAULT_ACTION } = require('../src/modules/legal/contracts/application/requirementRules.defaults');
  const { publishRequirementRules } = require('../src/modules/legal/contracts/application/requirementRules.service');
  const ct = await h.http('A:gestor', 'POST', '/contracts', { contractType: 'SALE_CASH', totalValue: 1000 });
  const pj = await h.http('A:gestor', 'POST', '/people', { personType: 'PJ', legalName: `Empresa Fictícia ${h.sfx()}` });
  const pf = await h.pessoa('A:gestor', 'Comprador');
  const procurador = await h.pessoa('A:gestor', 'Procurador');
  await h.http('A:gestor', 'POST', `/legal/contracts/${ct.data.id}/parties`, { personId: pj.data.id, partyRole: 'SELLER' });
  await h.http('A:gestor', 'POST', `/legal/contracts/${ct.data.id}/parties`, { personId: pf, partyRole: 'BUYER', representedByPersonId: procurador });
  const g = await h.http('A:gestor', 'POST', `/legal/contracts/${ct.data.id}/requirements/generate`, {});
  const codes = g.data.map((r) => r.requirementCode);
  assert.ok(codes.includes('SALE_CASH_PJ_DOCS'), 'parte PJ exige documentos da PJ');
  assert.ok(codes.includes('SALE_CASH_POWER_OF_ATTORNEY'), 'parte representada exige procuração');
  const [regra] = await h.sql('A:gestor', "SELECT r.code, v.version_number, v.status FROM legal.contract_requirements q JOIN core.rule_versions v ON v.id = q.rule_version_id JOIN core.rules r ON r.id = v.rule_id WHERE q.contract_id = :id LIMIT 1", { id: ct.data.id });
  assert.equal(regra.code, 'REG-JUR-001');
  assert.equal(regra.status, 'PUBLISHED');
  const templates = { ...DEFAULT_ACTION.templates, ADDENDUM: [...DEFAULT_ACTION.templates.ADDENDUM, { requirementCode: 'ADDENDUM_EXTRA', requirementType: 'PF_DOCUMENT', description: 'Exigência da nova versão da regra.' }] };
  await h.comTenant('A:gestor', (tx, tn) => publishRequirementRules(tn, { templates, typeToTemplate: DEFAULT_ACTION.typeToTemplate }, tn.userId, tx));
  try {
    const principal = await h.http('A:gestor', 'POST', '/contracts', { contractType: 'LEASE_RESIDENTIAL', totalValue: 1 });
    const s = await h.http('A:gestor', 'POST', '/contracts', { contractType: 'ADDENDUM', parentContractId: principal.data.id, totalValue: 1 });
    const gs = await h.http('A:gestor', 'POST', `/legal/contracts/${s.data.id}/requirements/generate`, {});
    assert.ok(gs.data.some((r) => r.requirementCode === 'ADDENDUM_EXTRA'), 'a política vem da versão vigente da regra');
  } finally {
    await h.comTenant('A:gestor', (tx, tn) => publishRequirementRules(tn, DEFAULT_ACTION, tn.userId, tx));
  }
});

test('§13: aditivo referencia contrato e versão base, registra motivo, vigência, cláusulas alteradas e a assinatura de cada signatário', async (t) => {
  if (pular) return t.skip(pular);
  const c = await h.contratoEmRevisao('A:gestor');
  const nasceAssinado = await h.http('A:gestor', 'POST', `/legal/contracts/${c.contractId}/amendments`, { reason: 'x', changes: [{ field: 'totalValue', newValue: 1 }], status: 'SIGNED' });
  assert.equal(nasceAssinado.code, 'LEGAL_CONTRACT_AMENDMENT_SIGNATURES_REQUIRED');
  const ad = await h.http('A:gestor', 'POST', `/legal/contracts/${c.contractId}/amendments`, {
    reason: 'Reajuste e nova redação da multa', changes: [{ field: 'totalValue', oldValue: 1500, newValue: 1600 }],
    changedClauses: [{ code: 'MULTA', change: 'Multa de 2%' }], effectiveFrom: '2026-12-01', effectiveUntil: '2027-11-30',
  });
  assert.equal(ad.status, 201, JSON.stringify(ad.body));
  assert.equal(ad.data.baseContractVersionId, c.versionId);
  assert.deepEqual([ad.data.effectiveFrom, ad.data.effectiveUntil], ['2026-12-01', '2027-11-30']);
  assert.deepEqual(ad.data.changedClauses, [{ code: 'MULTA', change: 'Multa de 2%', contractClauseId: null }]);
  const vig = await h.http('A:gestor', 'POST', `/legal/contracts/${c.contractId}/amendments`, { reason: 'x', changes: [{ field: 'a' }], effectiveFrom: '2027-01-01', effectiveUntil: '2026-01-01' });
  assert.equal(vig.code, 'LEGAL_CONTRACT_AMENDMENT_VALIDATION', 'vigência invertida');
  const via = await h.arquivo('A:gestor', 'aditivo.pdf');
  assert.equal((await h.http('A:gestor', 'POST', `/legal/amendments/${ad.data.id}/sign`, { documentFileId: via })).code, 'LEGAL_CONTRACT_AMENDMENT_SIGNER_REQUIRED');
  const estranho = await h.pessoa('A:gestor', 'Não é parte');
  assert.equal((await h.http('A:gestor', 'POST', `/legal/amendments/${ad.data.id}/sign`, { personId: estranho, documentFileId: via })).code, 'LEGAL_CONTRACT_AMENDMENT_SIGNER_NOT_PARTY');
  const s1 = await h.http('A:gestor', 'POST', `/legal/amendments/${ad.data.id}/sign`, { personId: c.landlord, evidenceFileId: via });
  assert.equal(s1.data.status, 'DRAFT', 'falta o locatário');
  assert.equal((await h.http('A:gestor', 'POST', `/legal/amendments/${ad.data.id}/sign`, { personId: c.landlord, evidenceFileId: via })).code, 'LEGAL_CONTRACT_AMENDMENT_SIGNER_ALREADY_SIGNED');
  const s2 = await h.http('A:gestor', 'POST', `/legal/amendments/${ad.data.id}/sign`, { personId: c.tenantPerson, evidenceFileId: via });
  assert.equal(s2.data.status, 'SIGNED');
  const sigs = await h.sql('A:gestor', 'SELECT person_id, party_role, evidence_file_id, collected_by_user_id FROM legal.addendum_signatures WHERE addendum_id = :id ORDER BY signed_at', { id: ad.data.id });
  assert.deepEqual(sigs.map((x) => x.party_role), ['LANDLORD', 'TENANT']);
  assert.ok(sigs.every((x) => x.evidence_file_id === via && x.collected_by_user_id === h.tenantOf('A:gestor').userId));
  await assert.rejects(
    h.comTenant('A:gestor', (tx) => sequelize.query('UPDATE legal.addendum_signatures SET signed_at = now() WHERE addendum_id = :id', { replacements: { id: ad.data.id }, transaction: tx })),
    /imutável/,
    'a assinatura do aditivo é imutável para o runtime'
  );
  const [tabela] = await h.sql('A:gestor', "SELECT to_regclass('legal.addenda') AS nova, to_regclass('legal.contract_amendments') AS antiga");
  assert.deepEqual(tabela, { nova: 'legal.addenda', antiga: null });
});

test('Guia §14: POST /webhooks/signature/:provider — Clicksign pelo webhook público validado; fornecedor com canal vai à rota única; desconhecido 404', async (t) => {
  if (pular) return t.skip(pular);
  const desconhecido = await h.http(null, 'POST', '/webhooks/signature/clicksign', { event: { name: 'sign', data: { signer: { key: 'chave-desconhecida' } } } });
  const [sig] = await h.sql('A:gestor', 'SELECT external_signature_id FROM legal.signatures WHERE external_signature_id IS NOT NULL LIMIT 1');
  const existente = await h.http(null, 'POST', '/webhooks/signature/clicksign', { event: { name: 'sign', data: { signer: { key: sig ? sig.external_signature_id : 'x' } } } });
  assert.deepEqual([desconhecido.status, desconhecido.code], [401, 'LEGAL_WEBHOOK_HMAC_INVALID'], 'mesmo handler de /legal/webhooks/clicksign: sem assinatura válida, 401');
  assert.deepEqual([existente.status, existente.code, existente.body.error.message], [401, 'LEGAL_WEBHOOK_HMAC_INVALID', desconhecido.body.error.message], 'sem oráculo: signatário existente e inexistente recebem a mesma resposta');
  const canalErrado = await h.http(null, 'POST', '/webhooks/signature/sandbox?channel=canal-inexistente', { id: 'x' });
  assert.equal(canalErrado.code, 'INTEGRATION_WEBHOOK_UNKNOWN_CHANNEL', 'com canal, a rota única do framework valida o canal');
  assert.equal((await h.http(null, 'POST', '/webhooks/signature/zapsign', { id: 'x' })).code, 'LEGAL_SIGNATURE_WEBHOOK_CHANNEL_REQUIRED');
  assert.equal((await h.http(null, 'POST', '/webhooks/signature/inventado', {})).code, 'LEGAL_SIGNATURE_WEBHOOK_PROVIDER_UNKNOWN');
});
