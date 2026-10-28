'use strict';

// M9-D016 — as tools iniciais do livro, o boot contra o catálogo real de permissões e a leitura por serviço de aplicação
// (banco real, nayara_runtime, transação com rollback; só roda pelo banco descartável).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../../testHelpers');
const { ToolRegistry, initToolRegistry } = require('../../../src/features/ai/tools');
const { executeTool } = require('../../../src/features/ai/tools/toolExecutor');
const { buildToolServices } = require('../../../src/features/ai/toolServices');
const peopleService = require('../../../src/features/people/people.service');
const opportunityService = require('../../../src/features/crm/opportunity.service');
const { defValida, LIMITES } = require('../_helpers/aiToolDefs');

after(async () => { await sequelize.close(); });

const LEITURA = ['crm.getOpportunity', 'crm.getCustomerSummary', 'radar.listMatchesForOpportunity', 'finance.getWeeklyHealth', 'finance.getDelinquency',
  'construction.getProjectProgress', 'legal.getContractSummary', 'correspondent.getCaseStatus', 'knowledge.search', 'memory.recall'];
const ESCRITA = { 'crm.createFollowUpTask': ['LOW', 'OTHER', false], 'finance.proposePayment': ['CRITICAL', 'FINANCIAL', true], 'legal.draftContract': ['HIGH', 'LEGAL', true] };

test('m9d016_tools_iniciais_existem_com_o_catalogo_real_de_permissoes', async () => {
  const reg = await initToolRegistry();
  const nomes = reg.list().map((t) => t.name);
  for (const n of [...LEITURA, ...Object.keys(ESCRITA)]) assert.ok(nomes.includes(n), `falta ${n}`);
  for (const n of LEITURA) {
    const t = reg.get(n);
    assert.equal(t.category, 'READ', n);
    assert.equal(typeof t.execute, 'function');
    assert.ok(t.permissionCode && t.inputSchema.type === 'object' && t.outputSchema.type === 'object');
  }
  for (const [n, [risco, dominio, aprova]] of Object.entries(ESCRITA)) {
    const t = reg.get(n);
    assert.equal(t.category, 'WRITE', n);
    assert.equal(t.riskLevel, risco, n);
    assert.equal(t.domain, dominio, n);
    assert.equal(t.requiresHumanApproval, aprova, n);
  }
  // Boot de verdade: o catálogo do banco recusa uma permissão que não existe em core.permissions.
  const real = new ToolRegistry({ permissionCodes: await require('../../../src/features/ai/tools').loadPermissionCodes() });
  assert.throws(() => real.register(defValida({ permissionCode: 'inventado:tudo' })), { code: 'AI_TOOL_DEFINITION_INVALID' });
  assert.doesNotThrow(() => real.register(defValida({ permissionCode: 'crm:opportunities:read' })));
});

test('m9d016_leitura_usa_application_service', async () => {
  const tenant = await getSeedTenant();
  const reg = await initToolRegistry();
  await withRollbackTenantTransaction(tenant, async (tx) => {
    const pessoa = await peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Lead ${uniqueSuffix()}` }, tenant.userId, tx);
    const opp = await opportunityService.createOpportunity({
      groupId: tenant.groupId, companyId: tenant.companyId, personId: pessoa.id, ownerUserId: tenant.userId,
      nextAction: 'Ligar', nextActionDueAt: new Date(Date.now() + 86400000).toISOString(),
    }, tenant.userId, tx);
    const chamadas = [];
    const { services, readModels } = buildToolServices(tx);
    // Espiona o serviço de aplicação: a tool tem de passar por ele.
    const espiao = { ...services, crmOpportunities: { ...services.crmOpportunities, getById: async (...a) => { chamadas.push(a); return services.crmOpportunities.getById(...a); } } };
    const rec = { record: async () => {}, emit: async () => {} };
    const r = await executeTool({
      registry: reg.executorMap(), toolName: 'crm.getOpportunity', input: { opportunityId: opp.id }, recorder: rec, argsLimits: LIMITES,
      contextParts: { auth: { userId: tenant.userId, permissions: ['crm:opportunities:read'] }, companyId: tenant.companyId, groupId: tenant.groupId, services: espiao, readModels, correlationId: 'c' },
    });
    assert.equal(r.status, 'SUCCEEDED');
    assert.equal(chamadas.length, 1);
    assert.deepEqual(chamadas[0], [opp.id]);
    assert.equal(r.output.id, opp.id);
    assert.equal(r.output.personId, pessoa.id);
    assert.equal(r.output.stage, 'NEW');
    assert.ok(!('lockVersion' in r.output) && !('deletedBy' in r.output), 'colunas internas não saem');
    // Leitura sem as demais colunas do serviço: o resumo do cliente também sai podado.
    const resumo = await executeTool({
      registry: reg.executorMap(), toolName: 'crm.getCustomerSummary', input: { personId: pessoa.id }, recorder: rec, argsLimits: LIMITES,
      contextParts: { auth: { userId: tenant.userId, permissions: ['people:read'] }, companyId: tenant.companyId, groupId: tenant.groupId, services, readModels, correlationId: 'c' },
    });
    assert.equal(resumo.output.id, pessoa.id);
    assert.ok(!('taxIdNormalized' in resumo.output) && !('taxIdNormalizedHash' in resumo.output));
    // Financeiro: o número vem do serviço (relatório semanal), sem o modelo calcular.
    const saude = await executeTool({
      registry: reg.executorMap(), toolName: 'finance.getWeeklyHealth', input: {}, recorder: rec, argsLimits: LIMITES,
      contextParts: { auth: { userId: tenant.userId, permissions: ['finance:read'] }, companyId: tenant.companyId, groupId: tenant.groupId, services, readModels, correlationId: 'c' },
    });
    assert.equal(typeof saude.output.payablePending.total, 'number');
    assert.equal(typeof saude.output.overdue.total, 'number');
  });
});
