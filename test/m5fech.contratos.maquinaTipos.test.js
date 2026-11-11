'use strict';

// Matriz de fechamento do Marco 5 (Contratos), segunda onda — máquina de estados igual ao Guia §3, gate de
// requirements por etapa (Guia §5) e tipos vinculados do Caderno §3 (ADDENDUM, KEY_DELIVERY, USED_PROPERTY_DELIVERY).
process.env.PORT = process.env.M5FECH_CT_PORT || '5534';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./m5fech.contratos.helpers');
const contractsService = require('../src/modules/legal/contracts/application/contract.service');

let pular = null;
before(async () => { pular = await h.pronto(); });
after(h.encerrar);

const GUIA_3 = {
  DRAFT: ['DOCUMENTS_PENDING', 'LEGAL_REVIEW'],
  DOCUMENTS_PENDING: ['LEGAL_REVIEW'],
  LEGAL_REVIEW: ['APPROVED', 'DRAFT'],
  APPROVED: ['SIGNING'],
  SIGNING: ['SIGNED', 'APPROVED'],
  SIGNED: ['ACTIVE'],
  ACTIVE: ['SUSPENDED', 'TERMINATED'],
  SUSPENDED: ['ACTIVE', 'TERMINATED'],
  TERMINATED: ['CLOSED'],
};

test('Guia §3: a tabela de transições é exatamente a do livro (CANCELLED não é alvo nem origem de transição)', () => {
  const { VALID_TRANSITIONS } = contractsService;
  for (const [de, para] of Object.entries(GUIA_3)) assert.deepEqual([...VALID_TRANSITIONS[de]].sort(), [...para].sort(), de);
  assert.deepEqual(VALID_TRANSITIONS.CLOSED, []);
  assert.deepEqual(VALID_TRANSITIONS.CANCELLED, [], 'contrato legado CANCELLED é terminal');
  assert.ok(Object.values(VALID_TRANSITIONS).every((alvos) => !alvos.includes('CANCELLED')), 'nenhuma transição leva a CANCELLED');
});

async function contratoComPartes() {
  const c = await h.http('A:gestor', 'POST', '/contracts', { contractType: 'LEASE_RESIDENTIAL', totalValue: 1000 });
  for (const papel of ['LANDLORD', 'TENANT']) {
    const p = await h.pessoa('A:gestor', `Parte ${papel}`);
    await h.http('A:gestor', 'POST', `/legal/contracts/${c.data.id}/parties`, { personId: p, partyRole: papel });
  }
  return c.data.id;
}
const transicao = (id, alvo) => h.http('A:checker', 'POST', `/legal/contracts/${id}/transition`, { targetStatus: alvo });

test('Guia §3/§5: DRAFT -> LEGAL_REVIEW direto com checklist completo; LEGAL_REVIEW -> DRAFT mesmo com pendência; atalhos fora do livro recusados', async (t) => {
  if (pular) return t.skip(pular);
  const id = await contratoComPartes();
  const reqs = (await h.http('A:gestor', 'POST', `/legal/contracts/${id}/requirements/generate`, {})).data;
  const pendente = await transicao(id, 'LEGAL_REVIEW');
  assert.equal(pendente.code, 'LEGAL_REQUIREMENTS_PENDING');
  assert.equal(pendente.body.error.details.stage, 'LEGAL_REVIEW', 'a recusa diz a etapa-alvo');
  for (const r of reqs) await h.http('A:gestor', 'POST', `/legal/requirements/${r.id}/waive`, { reason: 'Dispensa fictícia (matriz M5)' });
  assert.equal((await transicao(id, 'LEGAL_REVIEW')).status, 200, 'DRAFT -> LEGAL_REVIEW direto');
  assert.equal((await transicao(id, 'DOCUMENTS_PENDING')).code, 'LEGAL_CONTRACT_INVALID_TRANSITION', 'LEGAL_REVIEW -> DOCUMENTS_PENDING não existe no livro');
  assert.equal((await transicao(id, 'CANCELLED')).code, 'LEGAL_CONTRACT_INVALID_TRANSITION', 'CANCELLED não é alvo');
  const nova = await h.http('A:gestor', 'POST', `/legal/contracts/${id}/requirements/generate`, { templateKey: 'NEW_PROPERTY_DELIVERY' });
  assert.ok(nova.data.length > 0, 'exigências novas pendentes');
  assert.equal((await transicao(id, 'DRAFT')).status, 200, 'devolver para DRAFT não é bloqueado por documento');
});

test('Guia §5: exigência com etapa SIGNING não bloqueia a revisão jurídica, só o envio para assinatura', async (t) => {
  if (pular) return t.skip(pular);
  const { DEFAULT_ACTION } = require('../src/modules/legal/contracts/application/requirementRules.defaults');
  const { publishRequirementRules } = require('../src/modules/legal/contracts/application/requirementRules.service');
  const templates = { ...DEFAULT_ACTION.templates, SERVICE: [{ requirementCode: 'SERVICE_SIGNING_ONLY', requirementType: 'SERVICE_SCOPE', description: 'Exigência só para a assinatura.', stage: 'SIGNING' }] };
  await h.comTenant('A:gestor', (tx, tn) => publishRequirementRules(tn, { templates, typeToTemplate: DEFAULT_ACTION.typeToTemplate }, tn.userId, tx));
  try {
    const c = await h.http('A:gestor', 'POST', '/contracts', { contractType: 'SERVICE', totalValue: 1000 });
    assert.equal((await transicao(c.data.id, 'LEGAL_REVIEW')).status, 200, 'pendência de SIGNING não bloqueia LEGAL_REVIEW');
    const [req] = await h.sql('A:gestor', 'SELECT required_stage, rule_version_id IS NOT NULL AS da_regra FROM legal.contract_requirements WHERE contract_id = :id', { id: c.data.id });
    assert.deepEqual(req, { required_stage: 'SIGNING', da_regra: true });
    const f = await h.arquivo('A:gestor');
    await h.http('A:gestor', 'POST', `/contracts/${c.data.id}/versions`, { content: `Serviço ${h.sfx()}`, documentFileId: f });
    assert.equal((await transicao(c.data.id, 'APPROVED')).status, 200, 'nem a aprovação');
    const envio = await transicao(c.data.id, 'SIGNING');
    assert.equal(envio.code, 'LEGAL_REQUIREMENTS_PENDING');
    assert.equal(envio.body.error.details.stage, 'SIGNING');
  } finally {
    await h.comTenant('A:gestor', (tx, tn) => publishRequirementRules(tn, DEFAULT_ACTION, tn.userId, tx));
  }
});

test('Caderno §3: ADDENDUM, KEY_DELIVERY e USED_PROPERTY_DELIVERY são tipos de contrato vinculados ao contrato principal', async (t) => {
  if (pular) return t.skip(pular);
  const imovel = await h.http('A:gestor', 'POST', '/properties', { title: `Imóvel vinculado ${h.sfx()}`, internalCode: `VIN-${h.sfx()}`, propertyType: 'RESIDENTIAL' });
  const principal = await h.http('A:gestor', 'POST', '/contracts', { contractType: 'LEASE_RESIDENTIAL', totalValue: 1000, propertyId: imovel.data.id });
  const deB = await h.http('B:gestor', 'POST', '/contracts', { contractType: 'SALE_CASH', totalValue: 1 });
  for (const [tipo, prefixo] of [['ADDENDUM', 'ADT'], ['KEY_DELIVERY', 'CHV'], ['USED_PROPERTY_DELIVERY', 'IMU']]) {
    assert.equal((await h.http('A:gestor', 'POST', '/contracts', { contractType: tipo })).code, 'LEGAL_CONTRACT_PARENT_REQUIRED', `${tipo} sem principal`);
    assert.equal((await h.http('A:gestor', 'POST', '/contracts', { contractType: tipo, parentContractId: deB.data.id })).code, 'LEGAL_CONTRACT_PARENT_NOT_FOUND', `${tipo} com principal de outra empresa`);
    const ok = await h.http('A:gestor', 'POST', '/contracts', { contractType: tipo, parentContractId: principal.data.id });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.data.parentContractId, principal.data.id);
    assert.equal(ok.data.propertyId, imovel.data.id, 'herda o imóvel do principal');
    assert.match(ok.data.contractNumber, new RegExp(`^${prefixo}-\\d{4}-\\d{4}$`));
    assert.equal((await h.http('A:gestor', 'POST', '/contracts', { contractType: 'ADDENDUM', parentContractId: ok.data.id })).code, 'LEGAL_CONTRACT_PARENT_INVALID', 'principal não pode ser vinculado');
  }
  assert.equal((await h.http('A:gestor', 'POST', '/contracts', { contractType: 'SALE_CASH', parentContractId: principal.data.id })).code, 'LEGAL_CONTRACT_VALIDATION', 'tipo principal não recebe parentContractId');
});
