'use strict';

// Matriz de fechamento do Marco 5 (Contratos), terceira rodada — mensagens em português (sem código cru) e achados
// do pentest automatizado: id que não é uuid no corpo (400, não 500), versão de outro contrato no PDF (404) e
// permissão antes do guard de anexo (PERMISSION_DENIED). HTTP real, dois tenants do seed de CI.
process.env.PORT = process.env.M5FECH_CT_PORT || '5534';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./m5fech.contratos.helpers');

let pular = null;
before(async () => { pular = await h.pronto(); });
after(h.encerrar);

const OBJ = { $gt: '' };

test('Mensagens: recusa por documento faltante traz o rótulo das exigências; os códigos ficam em campo estruturado; a linha do tempo usa rótulos', async (t) => {
  if (pular) return t.skip(pular);
  const c = await h.http('A:gestor', 'POST', '/contracts', { contractType: 'SALE_FINANCED', totalValue: 1000 });
  await h.http('A:gestor', 'POST', `/legal/contracts/${c.data.id}/requirements/generate`, {});
  const r = await h.http('A:checker', 'POST', `/legal/contracts/${c.data.id}/transition`, { targetStatus: 'LEGAL_REVIEW' });
  assert.equal(r.code, 'LEGAL_REQUIREMENTS_PENDING');
  assert.match(r.body.error.message, /etapa de revisão jurídica: faltam documentos obrigatórios — Documentos do comprador; /);
  assert.doesNotMatch(r.body.error.message, /SALE_FIN_|[A-Z]{3,}_[A-Z]{3,}/, 'sem código cru na mensagem');
  assert.ok(r.body.error.details.missingRequirementCodes.includes('SALE_FIN_BUYER_DOCS'), 'códigos no campo estruturado');

  const k = await h.contratoEmRevisao('A:gestor');
  const linha = (await h.http('A:leitura', 'GET', `/legal/contracts/${k.contractId}/timeline`)).data.items.filter((i) => i.type === 'STATUS_CHANGE');
  assert.ok(linha.length >= 2);
  assert.equal(linha[0].summary, 'Situação do contrato mudou de "Rascunho" para "Documentos pendentes"');
  assert.deepEqual(linha[0].details, { fromStatus: 'DRAFT', toStatus: 'DOCUMENTS_PENDING' });
  assert.ok(linha.every((i) => !/DRAFT|DOCUMENTS_PENDING|LEGAL_REVIEW/.test(i.summary)), 'status cru não aparece no resumo');
});

test('Pentest (alto): id que não é uuid no corpo devolve 400 LEGAL_INVALID_ID, nunca 500, nas rotas de versão, checklist e modelo', async (t) => {
  if (pular) return t.skip(pular);
  const k = await h.contratoEmRevisao('A:gestor');
  const [req] = await h.sql('A:gestor', 'SELECT id FROM legal.contract_requirements WHERE contract_id = :id LIMIT 1', { id: k.contractId });
  const tpl = await h.http('A:maker', 'POST', '/legal/contract-templates', { name: `Modelo pentest ${h.sfx()}`, contractType: 'LEASE_RESIDENTIAL' });
  const casos = [
    ['PATCH', `/legal/requirements/${req.id}`, { satisfiedByFileId: OBJ }],
    ['POST', `/legal/contracts/${k.contractId}/versions`, { content: OBJ, documentFileId: OBJ }],
    ['POST', `/contracts/${k.contractId}/versions`, { templateId: OBJ, documentFileId: OBJ, variables: { nome_locatario: OBJ } }],
    ['POST', `/legal/contract-templates/${tpl.data.id}/clauses`, { contractClauseId: OBJ }],
    ['POST', `/contract-versions/${k.versionId}/send-signature`, { signerPersonIds: [OBJ] }],
    ['POST', '/contracts', { contractType: 'ADDENDUM', parentContractId: OBJ }],
  ];
  for (const [metodo, rota, corpo] of casos) {
    const r = await h.http('A:gestor', metodo, rota, corpo);
    assert.deepEqual([r.status, r.code], [400, 'LEGAL_INVALID_ID'], `${metodo} ${rota}`);
  }
});

test('Pentest (médio): o PDF da versão exige que a versão pertença ao contrato do caminho', async (t) => {
  if (pular) return t.skip(pular);
  const k = await h.contratoEmRevisao('A:gestor');
  const outro = await h.http('A:gestor', 'POST', '/contracts', { contractType: 'SALE_CASH', totalValue: 1 });
  for (const id of ['nao-e-uuid', "' OR 1=1--", outro.data.id]) {
    const r = await h.http('A:leitura', 'GET', `/legal/contracts/${encodeURIComponent(id)}/versions/${k.versionId}/generate-pdf`);
    assert.equal(r.status, 404, id);
    assert.equal(r.code, 'LEGAL_CONTRACT_VERSION_NOT_FOUND');
  }
});

test('Pentest (baixo): sem a permissão da rota a recusa é PERMISSION_DENIED, mesmo com arquivo de outra empresa no corpo; com a permissão o anexo é recusado', async (t) => {
  if (pular) return t.skip(pular);
  const k = await h.contratoEmRevisao('A:gestor');
  const deB = await h.arquivo('B:gestor', 'arquivo-de-b.pdf');
  const [fileA] = await h.sql('A:gestor', 'SELECT id FROM people.files WHERE id = :id', { id: k.fileId });
  const semPermissao = await h.http('A:leitura', 'POST', `/legal/contract-versions/${k.versionId}/manual-signatures`, { personId: k.landlord, evidenceFileId: fileA.id });
  assert.deepEqual([semPermissao.status, semPermissao.code], [403, 'PERMISSION_DENIED'], 'permissão antes do guard de anexo');
  const garantia = await h.http('A:leitura', 'POST', `/legal/contracts/${k.contractId}/guarantees`, { guaranteeType: 'DEPOSIT', amount: 1, documentFileId: k.fileId });
  assert.deepEqual([garantia.status, garantia.code], [403, 'PERMISSION_DENIED']);
  const comPermissao = await h.http('A:gestor', 'POST', `/legal/contracts/${k.contractId}/versions`, { content: 'x', documentFileId: deB });
  assert.equal(comPermissao.status, 404, 'com a permissão, o arquivo de outra empresa segue recusado (não existe para A)');
});
