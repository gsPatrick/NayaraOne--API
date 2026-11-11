'use strict';

// M3-25 (contrato: "Jornada E2E lead, Radar, visita, proposta, contrato, recebimento e comissão"), toda pela rota HTTP real, com
// os módulos que existem: CRM (lead, radar, visita, proposta, WON) -> Contratos (contrato de venda ligado à oportunidade até ATIVO)
// -> Financeiro (recebível do contrato e a baixa) -> Comissões (comissão do corretor sobre o recebimento, liberada pelo recebido).
// O MFA recente da baixa e da regra de comissão é o do apoio do Financeiro (linhas de MFA no banco descartável, nunca o endpoint).
// Grava de verdade: rodar só em banco descartável (scripts/withDisposableDb.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { portaLivre } = require('./marco9/_helpers/portaLivre');

process.env.PORT = process.env.M3CA_JORNADA_HTTP_PORT || portaLivre();
require('../app');
const { getSeedTenant, withTenantTransaction, uniqueSuffix, sequelize } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { createUser, client } = require('./helpers/m4FinanceHttp');
const { createMember } = require('./helpers/m3caCrm');

let tenant;
let http;
const CRM = ['people:create', 'people:read', 'properties:create', 'properties:read', 'properties:update', 'radar:create', 'radar:read', 'crm:opportunities:create',
  'crm:opportunities:read', 'crm:opportunities:read:all', 'crm:opportunities:update', 'crm:visits:create', 'crm:visits:read', 'crm:visits:update', 'crm:proposals:create',
  'crm:proposals:read', 'crm:proposals:update', 'crm:messages:create'];
const LEGAL = ['legal:read', 'legal:create', 'legal:update', 'legal:approve', 'legal:sign', 'legal:waive'];
const FINANCE = ['finance:read', 'finance:create', 'finance:update', 'finance:settle', 'finance:approve'];
const token = (userId, permissions) => signAccessToken({ sub: userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'], permissions });

before(async () => {
  if (process.env.DISPOSABLE_DB !== '1') throw new Error('Rode em banco descartável (scripts/withDisposableDb.js).');
  tenant = await getSeedTenant();
  http = client(`http://127.0.0.1:${process.env.PORT}/api/v1`);
  await new Promise((resolve) => setTimeout(resolve, 300));
});
after(async () => {
  await sequelize.close();
  process.exit(0);
});

const ok = (r, status, passo) => {
  assert.equal(r.status, status, `${passo}: ${JSON.stringify(r.body)}`);
  return r.body.data;
};
const arquivo = async (tk, nome) => ok(await http('POST', '/files', tk, {
  fileName: nome, mimeType: 'application/pdf', contentBase64: Buffer.from(`Documento fictício ${uniqueSuffix()}`).toString('base64'), category: 'generic',
}), 201, `arquivo ${nome}`).id;

test('M3-25: lead -> Radar -> visita -> proposta aceita -> WON -> contrato de venda ativo -> recebimento baixado -> comissão do corretor liberada', async () => {
  const sfx = uniqueSuffix();
  const corretor = await withTenantTransaction(tenant, (t) => createMember(tenant, t, { label: 'corretor-jornada', permissions: ['crm:opportunities:read:own'] }));
  const financeiro = await createUser(tenant, 'financeiro-jornada', 'recent');
  const comercial = token(tenant.userId, [...CRM, ...LEGAL, 'files:create']);
  const juridico = token(financeiro.id, [...LEGAL, 'files:create']);
  const caixa = token(financeiro.id, FINANCE);

  // 1. Lead: comprador e vendedor (proprietário) cadastrados; imóvel com oferta de venda.
  const comprador = ok(await http('POST', '/people', comercial, { personType: 'PF', legalName: `Comprador Jornada ${sfx}`, allowDuplicate: true }), 201, 'comprador').id;
  const vendedor = ok(await http('POST', '/people', comercial, { personType: 'PF', legalName: `Vendedor Jornada ${sfx}`, allowDuplicate: true }), 201, 'vendedor').id;
  const cidade = `Cidade Jornada ${sfx}`;
  const imovel = ok(await http('POST', '/properties', comercial, { title: `Casa Jornada ${sfx}`, internalCode: `JOR-${sfx}`, propertyType: 'RESIDENTIAL', city: cidade, areaTotalM2: 180 }), 201, 'imóvel').id;
  ok(await http('POST', `/properties/${imovel}/offers`, comercial, { offerType: 'SALE', askingPrice: 650000 }), 201, 'oferta de venda');
  const oportunidade = ok(await http('POST', '/crm/opportunities', comercial, {
    personId: comprador, ownerUserId: corretor, stage: 'QUALIFIED', nextAction: 'Rodar o radar e apresentar opções', nextActionDueAt: new Date(Date.now() + 86400000).toISOString(),
  }), 201, 'oportunidade');
  assert.equal(oportunidade.ownerUserId, corretor);

  // 2. Radar do cliente encontra o imóvel; ele vira o imóvel de interesse.
  const radar = ok(await http('POST', '/crm/radars', comercial, { personId: comprador, criteriaJson: { required: { offerType: 'SALE', city: cidade, maxPrice: 700000 } } }), 201, 'radar');
  const matches = ok(await http('GET', `/crm/radars/${radar.id}/matches`, comercial), 200, 'matches');
  assert.ok(matches.some((m) => m.id === imovel), 'o radar encontra o imóvel');
  ok(await http('PATCH', `/opportunities/${oportunidade.id}`, comercial, { stage: 'MATCHING' }), 200, 'matching');

  // 3. Visita agendada pela rota do livro e concluída.
  const visita = ok(await http('POST', `/crm/opportunities/${oportunidade.id}/visits`, comercial, { propertyId: imovel, scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString() }), 201, 'visita');
  assert.equal(visita.opportunityId, oportunidade.id);
  ok(await http('PATCH', `/visits/${visita.id}`, comercial, { status: 'DONE', feedback: 'Cliente gostou da casa' }), 200, 'visita concluída');

  // 4. Proposta ligada à oportunidade e ao imóvel, aceita.
  const proposta = ok(await http('POST', '/crm/proposals', comercial, { opportunityId: oportunidade.id, propertyId: imovel, value: 620000, status: 'SENT' }), 201, 'proposta');
  assert.equal(proposta.propertyId, imovel);
  assert.equal(ok(await http('PATCH', `/crm/proposals/${proposta.id}/status`, comercial, { status: 'ACCEPTED' }), 200, 'aceite').status, 'ACCEPTED');
  ok(await http('PATCH', `/opportunities/${oportunidade.id}`, comercial, { stage: 'CONTRACT', nextAction: 'Assinar contrato', nextActionDueAt: new Date(Date.now() + 86400000).toISOString() }), 200, 'contrato no funil');

  // 5. Contrato de venda ligado à oportunidade, do rascunho até ATIVO.
  const contrato = ok(await http('POST', '/legal/contracts', comercial, { contractType: 'SALE_CASH', propertyId: imovel, opportunityId: oportunidade.id, totalValue: 620000 }), 201, 'contrato');
  assert.equal(contrato.opportunityId, oportunidade.id);
  ok(await http('POST', `/legal/contracts/${contrato.id}/parties`, comercial, { personId: vendedor, partyRole: 'SELLER' }), 201, 'vendedor no contrato');
  ok(await http('POST', `/legal/contracts/${contrato.id}/parties`, comercial, { personId: comprador, partyRole: 'BUYER' }), 201, 'comprador no contrato');
  const exigencias = ok(await http('POST', `/legal/contracts/${contrato.id}/requirements/generate`, comercial, {}), 201, 'checklist');
  for (const e of exigencias) ok(await http('POST', `/legal/requirements/${e.id}/waive`, comercial, { reason: 'Documento conferido fora do sistema no teste da jornada' }), 200, 'dispensa');
  const versao = ok(await http('POST', `/legal/contracts/${contrato.id}/versions`, comercial, { content: `Contrato de compra e venda ${sfx}`, documentFileId: await arquivo(comercial, 'contrato.pdf') }), 201, 'versão');
  for (const alvo of ['DOCUMENTS_PENDING', 'LEGAL_REVIEW']) ok(await http('POST', `/legal/contracts/${contrato.id}/transition`, comercial, { targetStatus: alvo }), 200, alvo);
  ok(await http('POST', `/contract-versions/${versao.id}/approve`, juridico, {}), 200, 'aprovação da versão');
  let atual = ok(await http('GET', `/legal/contracts/${contrato.id}`, comercial), 200, 'contrato');
  if (atual.status !== 'APPROVED') ok(await http('POST', `/legal/contracts/${contrato.id}/transition`, juridico, { targetStatus: 'APPROVED' }), 200, 'APPROVED');
  ok(await http('POST', `/legal/contracts/${contrato.id}/transition`, comercial, { targetStatus: 'SIGNING' }), 200, 'SIGNING');
  for (const personId of [vendedor, comprador]) {
    ok(await http('POST', `/legal/contract-versions/${versao.id}/manual-signatures`, comercial, { personId, evidenceFileId: await arquivo(comercial, 'assinatura.pdf') }), 201, 'assinatura');
  }
  atual = ok(await http('GET', `/legal/contracts/${contrato.id}`, comercial), 200, 'contrato assinado');
  assert.equal(atual.status, 'SIGNED');
  assert.equal(ok(await http('POST', `/legal/contracts/${contrato.id}/transition`, comercial, { targetStatus: 'ACTIVE' }), 200, 'ACTIVE').status, 'ACTIVE');

  // 6. Oportunidade ganha (código do livro) depois do contrato ativo.
  const ganha = ok(await http('PATCH', `/opportunities/${oportunidade.id}`, comercial, { stage: 'WON', wonReason: 'PRICE_ACCEPTED' }), 200, 'WON');
  assert.equal(ganha.stage, 'WON');

  // 7. Recebimento: o recebível do contrato e a baixa (MFA recente do usuário do Financeiro).
  const centro = ok(await http('POST', '/finance/result-centers', caixa, { code: `JOR${sfx}`.slice(0, 20), name: `Vendas jornada ${sfx}` }), 201, 'centro de resultado');
  const recebivel = ok(await http('POST', '/finance/entries', caixa, {
    entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 620000, resultCenterId: centro.id, contractId: contrato.id, dueAt: new Date(Date.now() + 86400000).toISOString(),
    description: `Sinal e quitação da venda ${sfx}`, idempotencyKey: `jornada-recebivel-${sfx}`,
  }), 201, 'recebível');
  assert.equal(recebivel.contractId, contrato.id);
  const baixa = ok(await http('POST', `/finance/entries/${recebivel.id}/settle`, caixa, { idempotencyKey: `jornada-baixa-${sfx}` }), 200, 'baixa');
  assert.equal((baixa.entry || baixa).status, 'SETTLED');

  // 8. Comissão do corretor da oportunidade sobre o recebimento, pela regra publicada (5%).
  ok(await http('POST', '/finance/commission-rule', caixa, { componentPercentages: { BROKER: 5 } }), 200, 'regra de comissão');
  const comissao = ok(await http('POST', '/finance/commissions', caixa, {
    beneficiaryUserId: corretor, sourceEntryId: recebivel.id, component: 'BROKER', idempotencyKey: `jornada-comissao-${sfx}`, opportunityId: oportunidade.id,
  }), 201, 'comissão');
  assert.equal(comissao.commission.opportunityId, oportunidade.id);
  assert.equal(comissao.commission.contractId, contrato.id, 'a comissão herda o contrato do recebimento');
  assert.equal(Number(comissao.commission.totalAmount), 31000, 'comissão = 5% de 620.000,00');
  const liberada = ok(await http('GET', `/finance/commissions/${comissao.commission.id}/release`, caixa), 200, 'liberação');
  assert.equal(Number(liberada.releasedAmount), 31000, 'recebido 100%: comissão inteira liberada');

  // A linha do tempo da oportunidade conta a jornada do CRM: visita, proposta e o ganho.
  const linha = ok(await http('GET', `/opportunities/${oportunidade.id}/timeline`, comercial), 200, 'linha do tempo');
  const tipos = new Set(linha.map((i) => i.type));
  for (const tipo of ['VISIT', 'PROPOSAL', 'STAGE_CHANGE']) assert.ok(tipos.has(tipo), `linha do tempo tem ${tipo}`);
  assert.ok(linha.some((i) => i.type === 'STAGE_CHANGE' && i.data.toStage === 'WON' && i.data.wonReason === 'PRICE_ACCEPTED'));
});
