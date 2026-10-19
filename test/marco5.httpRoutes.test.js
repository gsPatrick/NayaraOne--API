'use strict';

// GAP REAL CORRIGIDO (varredura completa Marco 5 contra o Caderno Técnico, 12/10/2026): toda a
// cobertura de testes do Marco 5 chamava os services diretamente — nenhum arquivo batia com
// requisição HTTP real contra o Express app (auth JWT real + middleware de tenant real + rotas
// reais), mesmo padrão já corrigido no Marco 4 (`marco4.httpRoutes.test.js`). Prova em
// particular o fluxo de checklist de documentos (JUR-003/JUR-015, o gate fail-closed que é o
// próprio bug crítico corrigido nesta sessão) ponta a ponta — gerar checklist, listar via HTTP,
// dispensar um requirement via HTTP (`PATCH /legal/requirements/:id`, que não tinha NENHUM
// client/tela até esta rodada) — e também a biblioteca de cláusulas e as notificações formais,
// as outras duas features que tinham rota pronta sem nenhum client/tela.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.MARCO5_HTTP_TEST_PORT || '21597';

require('../app');
const { getSeedTenant, uniqueSuffix } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { Contract, ContractRequirement, ContractClause, Notice } = require('../src/models');

let tenant;
let baseUrl;
let token;

const createdContractIds = [];
const createdClauseIds = [];
const createdNoticeIds = [];

before(async () => {
  tenant = await getSeedTenant();

  token = signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['admin'],
    permissions: ['legal:create', 'legal:read', 'legal:update', 'legal:approve', 'legal:waive'],
  });

  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  if (createdNoticeIds.length > 0) await Notice.destroy({ where: { id: createdNoticeIds }, force: true });
  if (createdClauseIds.length > 0) await ContractClause.destroy({ where: { id: createdClauseIds }, force: true });
  if (createdContractIds.length > 0) {
    await ContractRequirement.destroy({ where: { contractId: createdContractIds }, force: true });
    await Contract.destroy({ where: { id: createdContractIds }, force: true });
  }

  const { sequelize } = require('./testHelpers');
  await sequelize.close();
  process.exit(0);
});

async function http(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

test('Marco 5 ponta a ponta via HTTP real: checklist de documentos (JUR-003/JUR-015) -> listar -> dispensar', async () => {
  const suffix = uniqueSuffix();

  const contract = await http('POST', '/legal/contracts', {
    contractType: 'LEASE_RESIDENTIAL',
    totalValue: 1500,
  });
  assert.equal(contract.status, 201, JSON.stringify(contract.body));
  createdContractIds.push(contract.body.data.id);

  const generated = await http('POST', `/legal/contracts/${contract.body.data.id}/requirements/generate`, {});
  assert.equal(generated.status, 201, JSON.stringify(generated.body));
  assert.ok(Array.isArray(generated.body.data));
  assert.ok(generated.body.data.length >= 1, 'checklist deve ter pelo menos 1 requirement gerado para LEASE_RESIDENTIAL');

  const listed = await http('GET', `/legal/contracts/${contract.body.data.id}/requirements`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.length, generated.body.data.length);
  assert.ok(listed.body.data.every((r) => r.status === 'PENDING'));

  // Avançar o contrato ANTES de resolver o checklist deve ser bloqueado (fail closed, mesmo
  // bug crítico já corrigido — prova de novo, agora via HTTP real).
  const blockedTransition = await http('POST', `/legal/contracts/${contract.body.data.id}/transition`, { targetStatus: 'DOCUMENTS_PENDING' });
  assert.equal(blockedTransition.status, 409, JSON.stringify(blockedTransition.body));
  assert.equal(blockedTransition.body.error.code, 'LEGAL_REQUIREMENTS_PENDING');

  // Dispensa via PATCH /legal/requirements/:id — rota que já existia no backend sem nenhum
  // client/tela até esta rodada.
  const firstRequirementId = listed.body.data[0].id;
  const waived = await http('PATCH', `/legal/requirements/${firstRequirementId}`, { waivedReason: `Dispensado em teste HTTP ${suffix}` });
  assert.equal(waived.status, 200, JSON.stringify(waived.body));
  assert.equal(waived.body.data.status, 'WAIVED');
  assert.equal(waived.body.data.waivedReason, `Dispensado em teste HTTP ${suffix}`);
});

test('Marco 5 ponta a ponta via HTTP real: biblioteca de cláusulas (JUR-002) -> criar -> listar -> versionar', async () => {
  const suffix = uniqueSuffix();
  const code = `HTTP_CLAUSE_${suffix.slice(-8)}`;

  const created = await http('POST', '/legal/clauses', {
    code,
    title: `Cláusula HTTP ${suffix}`,
    bodyText: 'Texto da versão 1.',
    category: 'GENERAL',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  createdClauseIds.push(created.body.data.id);
  assert.equal(created.body.data.versionNumber, 1);

  const listed = await http('GET', '/legal/clauses');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.data.some((c) => c.code === code));

  const versioned = await http('POST', `/legal/clauses/${code}/versions`, { bodyText: 'Texto da versão 2.' });
  assert.equal(versioned.status, 201, JSON.stringify(versioned.body));
  createdClauseIds.push(versioned.body.data.id);
  assert.equal(versioned.body.data.versionNumber, 2);

  const versions = await http('GET', `/legal/clauses/${code}/versions`);
  assert.equal(versions.status, 200);
  assert.equal(versions.body.data.length, 2);
});

// F01 (conferência Nayara 18/10/2026): a condição declarativa chega pela rota real, texto
// executável é recusado com 400 e o autor não aprova a própria regra (403). A avaliação no
// render está coberta em test/legal.clauseConditions.test.js.
test('F01 via HTTP real: cláusula condicional criada pendente, texto executável recusado, autor não aprova a própria condição', async () => {
  const suffix = uniqueSuffix();
  const created = await http('POST', '/legal/clauses', {
    code: `HTTP-COND-${suffix}`,
    title: 'Fiança',
    bodyText: 'Obrigações do fiador',
    category: 'GUARANTEE',
    condition: { match: 'all', rules: [{ variable: 'guaranteeType', operator: 'eq', value: 'GUARANTOR' }] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  createdClauseIds.push(created.body.data.id);
  assert.equal(created.body.data.conditionStatus, 'PENDING_APPROVAL');

  const executable = await http('POST', '/legal/clauses', {
    code: `HTTP-COND-X-${suffix}`,
    title: 'X',
    bodyText: 'Y',
    category: 'GENERAL',
    condition: 'contractType === "LEASE" && process.exit()',
  });
  assert.equal(executable.status, 400);
  assert.equal(executable.body.error.code, 'LEGAL_CLAUSE_CONDITION_INVALID');

  const selfApprove = await http('POST', `/legal/clauses/${created.body.data.id}/approve-condition`);
  assert.equal(selfApprove.status, 403);
  assert.equal(selfApprove.body.error.code, 'LEGAL_CLAUSE_CONDITION_SELF_APPROVAL_BLOCKED');
});

test('Marco 5 ponta a ponta via HTTP real: notificação formal (seção 13) -> rascunho -> revisão -> aprovar', async () => {
  const suffix = uniqueSuffix();

  const contract = await http('POST', '/legal/contracts', { contractType: 'LEASE_RESIDENTIAL', totalValue: 1000 });
  assert.equal(contract.status, 201, JSON.stringify(contract.body));
  createdContractIds.push(contract.body.data.id);

  const notice = await http('POST', '/legal/notices', {
    contractId: contract.body.data.id,
    channel: 'EMAIL',
    recipientDescription: `Locatário teste ${suffix}`,
    content: `Conteúdo da notificação HTTP ${suffix}`,
  });
  assert.equal(notice.status, 201, JSON.stringify(notice.body));
  createdNoticeIds.push(notice.body.data.id);
  assert.equal(notice.body.data.status, 'DRAFT');

  const submitted = await http('POST', `/legal/notices/${notice.body.data.id}/submit-for-review`, {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.data.status, 'PENDING_REVIEW');

  const approved = await http('POST', `/legal/notices/${notice.body.data.id}/approve`, {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.data.status, 'APPROVED');
});
