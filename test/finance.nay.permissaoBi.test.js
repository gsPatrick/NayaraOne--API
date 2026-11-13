'use strict';

// Integração dos Marcos 3 a 6 com o Marco 9 (M9-D700): a NAY Financeira lê o read model do BI pela camada do BI. No caminho de usuário (a rota
// passa as permissões da sessão), sem a permissão do domínio Financeiro o BI responde 403 PERMISSION_DENIED; com ela, lê sob o RLS da empresa.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const bi = require('../src/features/analytics/read-models/finance-assistant.read');
const { getFinanceInsights } = require('../src/modules/finance/application/services/finance-nay.service');

after(async () => { await sequelize.close(); });

test('BI da NAY Financeira: sessão sem a permissão do domínio Financeiro recebe 403 PERMISSION_DENIED (saúde e margem por setor)', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (t) => {
    const semFinanceiro = { ...tenant, permissions: ['crm:opportunities:read'] };
    await assert.rejects(bi.readFinanceHealthForAssistant(semFinanceiro, '2026-11-13', t), (e) => e.code === 'PERMISSION_DENIED' && e.details.permission === 'finance:read');
    await assert.rejects(bi.readSectorMarginsForAssistant(semFinanceiro, ['2026-11'], t), (e) => e.code === 'PERMISSION_DENIED');
    await assert.rejects(getFinanceInsights(tenant, tenant.userId, t, { permissions: ['crm:opportunities:read'] }), (e) => e.code === 'PERMISSION_DENIED');
  });
});

test('BI da NAY Financeira: com finance:read na sessão a leitura passa (e nada além do SELECT acontece)', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ok = await getFinanceInsights(tenant, tenant.userId, t, { permissions: ['finance:read'] });
    assert.ok(ok && typeof ok === 'object');
    assert.deepEqual(Object.keys(bi.FINANCE_ASSISTANT_READ_MODELS).sort(), ['health', 'sectorMargin']);
  });
});
