'use strict';

// Conferência Nayara 18/10/2026, roteiro item 4, aplicado aos Marcos 4 (Financeiro) e 5
// (Jurídico): ambiente isolado e descartável com fixtures fictícias, dois tenants e perfis
// maker/checker/leitura. Mesmo seed e mesmo harness de test/ciTwoTenantsProfiles.test.js (que
// cobre Compras): login real com senha → JWT com as permissões efetivas lidas do banco → rotas
// reais com auth + tenant + RLS, rodando como usuário de runtime sem BYPASSRLS no CI.
//
// Financeiro:
//   1. maker cria lançamento a pagar e pede aprovação; maker não aprova (403, sem finance:approve);
//   2. checker aprova o pedido do maker;
//   3. checker não aprova a solicitação que ele mesmo abriu (regra FINANCE_APPROVAL_SELF_APPROVAL_FORBIDDEN);
//   4. leitura recebe 403 ao criar lançamento e ao pedir aprovação, e consegue listar;
//   5. tenant B não lê o lançamento de A nem decide a aprovação de A (404), e A segue intacto.
// Jurídico:
//   6. maker cria contrato (rascunho); leitura recebe 403 ao criar e consegue ler;
//   7. tenant B não lê o contrato de A nem o altera (transição) — 404, e A segue intacto;
//   8. condição de cláusula: maker não aprova (403), checker não aprova a que ele criou
//      (LEGAL_CLAUSE_CONDITION_SELF_APPROVAL_BLOCKED), checker aprova a do maker, tenant B não
//      aprova a de A (404).
// Fora do CI (sem o seed ou sem CI_TENANT_USERS_PASSWORD) os testes são PULADOS com motivo
// explícito — nunca dão falso verde nem quebram a suíte local.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { emailFor } = require('../scripts/seed-ci-two-tenants');
const { sequelize, User } = require('../src/models');

process.env.PORT = process.env.CI_TWO_TENANTS_FIN_LEGAL_HTTP_TEST_PORT || '21602';

let skipReason = null;
let appLoaded = false;
let baseUrl;
const tokens = {};
const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;

before(async () => {
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  if (!password) {
    skipReason = 'CI_TENANT_USERS_PASSWORD ausente — seed de dois tenants só existe no workflow do CI.';
    return;
  }
  const seeded = await User.findOne({ where: { email: emailFor('A', 'maker') } });
  if (!seeded) {
    skipReason = 'Usuários do seed de dois tenants não encontrados — rode scripts/seed-ci-two-tenants.js (o CI roda).';
    return;
  }

  require('../app');
  appLoaded = true;
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));

  for (const tenantKey of ['A', 'B']) {
    for (const profile of ['maker', 'checker', 'leitura']) {
      // Vários arquivos de teste entram com os MESMOS usuários do seed ao mesmo tempo; o login
      // atualiza a linha do usuário e pode perder a corrida (409 OPTIMISTIC_LOCK_CONFLICT). Repete.
      let res; let body;
      for (let tentativa = 0; tentativa < 5; tentativa += 1) {
        res = await fetch(`${baseUrl}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: emailFor(tenantKey, profile), password }),
        });
        body = await res.json();
        if (res.status !== 409) break;
        await new Promise((resolve) => setTimeout(resolve, 200 * (tentativa + 1)));
      }
      assert.equal(res.status, 200, `login de ${tenantKey}/${profile} deveria funcionar: ${JSON.stringify(body)}`);
      tokens[`${tenantKey}:${profile}`] = body.data.accessToken;
    }
  }
});

after(async () => {
  await sequelize.close().catch(() => {});
  if (appLoaded) process.exit(0);
});

async function call(who, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let costCenterSeq = 0;
async function createPayable(who, label) {
  costCenterSeq += 1;
  const costCenter = await call(who, 'POST', '/finance/cost-centers', {
    code: `CI-CC-${suffix}-${costCenterSeq}`,
    name: `Centro de custo fictício CI ${label}`,
  });
  assert.equal(costCenter.status, 201, JSON.stringify(costCenter.body));
  const entry = await call(who, 'POST', '/finance/entries', {
    entryType: 'DEBIT',
    nature: 'PAYABLE',
    amount: 250,
    dueAt: '2030-01-10',
    description: `CI dois tenants — ${label}`,
    costCenterId: costCenter.body.data.id,
  });
  assert.equal(entry.status, 201, JSON.stringify(entry.body));
  return entry.body.data;
}

async function requestApproval(who, entryId) {
  return call(who, 'POST', '/finance/approval-requests', {
    relatedEntityType: 'FinancialEntry',
    relatedEntityId: entryId,
    riskLevel: 'LOW',
  });
}

// --- Financeiro (Marco 4) ---

test('CI dois tenants (Financeiro): maker cria e pede aprovação, maker NÃO aprova (403), checker aprova', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const entry = await createPayable('A:maker', 'maker-checker');
  const approval = await requestApproval('A:maker', entry.id);
  assert.equal(approval.status, 201, JSON.stringify(approval.body));
  assert.equal(approval.body.data.status, 'PENDING');

  const makerDecides = await call('A:maker', 'POST', `/finance/approval-requests/${approval.body.data.id}/decide`, { decision: 'APPROVED' });
  assert.equal(makerDecides.status, 403);
  assert.equal(makerDecides.body.error.code, 'PERMISSION_DENIED');

  const checkerDecides = await call('A:checker', 'POST', `/finance/approval-requests/${approval.body.data.id}/decide`, { decision: 'APPROVED' });
  assert.equal(checkerDecides.status, 200, JSON.stringify(checkerDecides.body));
  assert.equal(checkerDecides.body.data.approvalRequest.status, 'APPROVED');
});

test('CI dois tenants (Financeiro): checker com finance:approve NÃO aprova a solicitação que ele mesmo abriu', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const entry = await createPayable('A:checker', 'autoaprovacao');
  const approval = await requestApproval('A:checker', entry.id);
  assert.equal(approval.status, 201, JSON.stringify(approval.body));

  const selfDecides = await call('A:checker', 'POST', `/finance/approval-requests/${approval.body.data.id}/decide`, { decision: 'APPROVED' });
  assert.equal(selfDecides.status, 403);
  assert.equal(selfDecides.body.error.code, 'FINANCE_APPROVAL_SELF_APPROVAL_FORBIDDEN');
});

test('CI dois tenants (Financeiro): leitura recebe 403 ao criar lançamento e ao pedir aprovação, e consegue listar', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const readerCreates = await call('A:leitura', 'POST', '/finance/entries', {
    entryType: 'DEBIT',
    nature: 'PAYABLE',
    amount: 10,
    dueAt: '2030-01-10',
    description: 'CI leitura não cria',
  });
  assert.equal(readerCreates.status, 403);
  assert.equal(readerCreates.body.error.code, 'PERMISSION_DENIED');

  const entry = await createPayable('A:maker', 'leitura-pede-aprovacao');
  const readerRequests = await requestApproval('A:leitura', entry.id);
  assert.equal(readerRequests.status, 403);
  assert.equal(readerRequests.body.error.code, 'PERMISSION_DENIED');

  const readerLists = await call('A:leitura', 'GET', '/finance/entries');
  assert.equal(readerLists.status, 200);
  const readerReads = await call('A:leitura', 'GET', `/finance/entries/${entry.id}`);
  assert.equal(readerReads.status, 200);
  assert.equal(readerReads.body.data.id, entry.id);
});

test('CI dois tenants (Financeiro): tenant B não lê o lançamento de A nem decide a aprovação de A (404)', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const entry = await createPayable('A:maker', 'isolamento');
  const approval = await requestApproval('A:maker', entry.id);
  assert.equal(approval.status, 201, JSON.stringify(approval.body));

  const readB = await call('B:leitura', 'GET', `/finance/entries/${entry.id}`);
  assert.equal(readB.status, 404, `tenant B leu o lançamento de A: ${JSON.stringify(readB.body)}`);

  const listB = await call('B:leitura', 'GET', '/finance/approval-requests');
  assert.equal(listB.status, 200);
  assert.ok(!listB.body.data.some((r) => r.id === approval.body.data.id), 'aprovação de A apareceu na lista do tenant B');

  const decideB = await call('B:checker', 'POST', `/finance/approval-requests/${approval.body.data.id}/decide`, { decision: 'APPROVED' });
  assert.equal(decideB.status, 404, `checker do tenant B decidiu aprovação de A: ${JSON.stringify(decideB.body)}`);

  const stillA = await call('A:leitura', 'GET', `/finance/approval-requests?relatedEntityId=${entry.id}`);
  assert.equal(stillA.status, 200);
  const approvalOfA = stillA.body.data.find((r) => r.id === approval.body.data.id);
  assert.ok(approvalOfA, 'a aprovação de A tem que continuar visível para A');
  assert.equal(approvalOfA.status, 'PENDING', 'a aprovação de A não pode ter sido decidida pelo tenant B');
});

// --- Jurídico (Marco 5) ---

test('CI dois tenants (Jurídico): maker cria contrato; leitura recebe 403 ao criar e consegue ler', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const created = await call('A:maker', 'POST', '/legal/contracts', { contractType: 'LEASE_RESIDENTIAL', totalValue: 1000 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.status, 'DRAFT');

  const readerCreates = await call('A:leitura', 'POST', '/legal/contracts', { contractType: 'LEASE_RESIDENTIAL', totalValue: 1000 });
  assert.equal(readerCreates.status, 403);
  assert.equal(readerCreates.body.error.code, 'PERMISSION_DENIED');

  const readerReads = await call('A:leitura', 'GET', `/legal/contracts/${created.body.data.id}`);
  assert.equal(readerReads.status, 200);
  assert.equal(readerReads.body.data.id, created.body.data.id);
});

test('CI dois tenants (Jurídico): tenant B não lê nem altera o contrato de A (404), e o contrato segue intacto', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const created = await call('A:maker', 'POST', '/legal/contracts', { contractType: 'LEASE_RESIDENTIAL', totalValue: 1000 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const idFromA = created.body.data.id;

  const listB = await call('B:leitura', 'GET', '/legal/contracts');
  assert.equal(listB.status, 200);
  const rowsB = Array.isArray(listB.body.data) ? listB.body.data : listB.body.data.items || listB.body.data.rows || [];
  assert.ok(!rowsB.some((c) => c.id === idFromA), 'contrato de A apareceu na lista do tenant B');

  const readB = await call('B:leitura', 'GET', `/legal/contracts/${idFromA}`);
  assert.equal(readB.status, 404, `tenant B leu o contrato de A: ${JSON.stringify(readB.body)}`);

  const transitionB = await call('B:checker', 'POST', `/legal/contracts/${idFromA}/transition`, { targetStatus: 'DOCUMENTS_PENDING' });
  assert.equal(transitionB.status, 404, `checker do tenant B alterou o contrato de A: ${JSON.stringify(transitionB.body)}`);

  const stillA = await call('A:leitura', 'GET', `/legal/contracts/${idFromA}`);
  assert.equal(stillA.status, 200);
  assert.equal(stillA.body.data.status, 'DRAFT', 'o contrato de A não pode ter mudado de status pelo tenant B');
});

test('CI dois tenants (Jurídico): condição de cláusula — maker não aprova, checker não aprova a própria, checker aprova a do maker, tenant B não aprova a de A', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const condition = { match: 'all', rules: [{ variable: 'guaranteeType', operator: 'eq', value: 'GUARANTOR' }] };

  const makerClause = await call('A:maker', 'POST', '/legal/clauses', {
    code: `CI-COND-M-${suffix}`,
    title: 'Fiança (CI)',
    bodyText: 'Obrigações do fiador — cláusula fictícia de CI.',
    category: 'GUARANTEE',
    condition,
  });
  assert.equal(makerClause.status, 201, JSON.stringify(makerClause.body));
  assert.equal(makerClause.body.data.conditionStatus, 'PENDING_APPROVAL');
  const makerClauseId = makerClause.body.data.id;

  const makerApproves = await call('A:maker', 'POST', `/legal/clauses/${makerClauseId}/approve-condition`);
  assert.equal(makerApproves.status, 403);
  assert.equal(makerApproves.body.error.code, 'PERMISSION_DENIED');

  const crossTenant = await call('B:checker', 'POST', `/legal/clauses/${makerClauseId}/approve-condition`);
  assert.equal(crossTenant.status, 404, `checker do tenant B aprovou condição de A: ${JSON.stringify(crossTenant.body)}`);

  const checkerApproves = await call('A:checker', 'POST', `/legal/clauses/${makerClauseId}/approve-condition`);
  assert.equal(checkerApproves.status, 200, JSON.stringify(checkerApproves.body));
  assert.equal(checkerApproves.body.data.conditionStatus, 'APPROVED');

  const checkerClause = await call('A:checker', 'POST', '/legal/clauses', {
    code: `CI-COND-C-${suffix}`,
    title: 'Fiança do checker (CI)',
    bodyText: 'Cláusula fictícia criada pelo próprio checker.',
    category: 'GUARANTEE',
    condition,
  });
  assert.equal(checkerClause.status, 201, JSON.stringify(checkerClause.body));
  const selfApproves = await call('A:checker', 'POST', `/legal/clauses/${checkerClause.body.data.id}/approve-condition`);
  assert.equal(selfApproves.status, 403);
  assert.equal(selfApproves.body.error.code, 'LEGAL_CLAUSE_CONDITION_SELF_APPROVAL_BLOCKED');
});
