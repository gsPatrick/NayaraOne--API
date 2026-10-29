'use strict';

// Marco 9, M9-D240 — o Correspondente sobre o registro genérico: bateria inalterada, contas via registry e tabelas antigas somente leitura.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const env = require('../_helpers/m9d240Env');
const manifesto = require('../_helpers/m9d240Bateria.json');
const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
const accounts = require('../../../src/features/correspondent/providerAccounts.service');
const { resolveFinancingProviderAdapter, resolveFinancingProviderAdapterByCode } = require('../../../src/features/correspondent/adapters/resolveFinancingProviderAdapter');
const { SandboxFinancingProviderAdapter, ManualWorkflowFinancingProviderAdapter } = require('../../../src/features/correspondent/adapters/FinancingProviderAdapter');
const { IntegrationConnection, IntegrationProvider } = require('../../../src/models');

const { sequelize, withRollbackTenantTransaction, uniqueSuffix } = env;
let tenant;
const RAIZ = path.resolve(__dirname, '../../..');

before(async () => { tenant = await env.carregar(); });
after(async () => { await sequelize.close(); });

/** Espiona o registro: devolve os ids das connections resolvidas e a quantidade de instâncias criadas sem connection. */
function espiarRegistro() {
  const orig = { resolve: adapterRegistry.resolve, instantiate: adapterRegistry.instantiate };
  const visto = { connections: [], instancias: [] };
  adapterRegistry.resolve = async (connection, ...resto) => { visto.connections.push(connection.id); return orig.resolve(connection, ...resto); };
  adapterRegistry.instantiate = (code) => { visto.instancias.push(code); return orig.instantiate(code); };
  return { visto, restaurar: () => { adapterRegistry.resolve = orig.resolve; adapterRegistry.instantiate = orig.instantiate; } };
}

test('financiamento_bateria_correspondente_inalterada_verde', async () => {
  // A bateria (todos os test/correspondent* e o de erros do Correspondente) roda sem alterar nenhuma expectativa: os arquivos têm o mesmo hash de antes da migração.
  for (const [arquivo, hash] of Object.entries(manifesto.arquivos)) {
    const atual = crypto.createHash('sha256').update(fs.readFileSync(path.join(RAIZ, arquivo))).digest('hex');
    assert.equal(atual, hash, `${arquivo} foi alterado: a bateria do Correspondente não pode mudar de expectativa`);
  }
  assert.ok(Object.keys(manifesto.arquivos).length >= 20);
  // E o Correspondente agora fala com o registro: o adapter do contrato é resolvido pelo AdapterRegistry, com a interface original preservada.
  const espiao = espiarRegistro();
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const adapter = await resolveFinancingProviderAdapter(tenant, t);
      assert.ok(adapter instanceof SandboxFinancingProviderAdapter);
      ['simulate', 'submitCase', 'getCaseStatus', 'uploadDocument', 'requestAppraisal', 'cancelCase', 'findSubmissionByKey', 'normalizeProviderStatus', 'verifyWebhook'].forEach((m) => assert.equal(typeof adapter[m], 'function', m));
    });
    assert.equal(espiao.visto.connections.length, 1, 'resolveFinancingProviderAdapter delega ao AdapterRegistry.resolve(connection)');
    assert.ok(resolveFinancingProviderAdapterByCode('manual') instanceof ManualWorkflowFinancingProviderAdapter);
    assert.deepEqual(espiao.visto.instancias, ['financing-manual'], 'o roteamento do webhook também sai do registro');
  } finally { espiao.restaurar(); }
});

test('financiamento_provider_accounts_via_registry', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    // Isola o estado deixado por outros testes no mesmo banco (DI-D240-10): com mais de uma connection do fornecedor, só uma pode estar ACTIVE, e é ela que o resolvedor devolve.
    await IntegrationConnection.update({ status: 'DISABLED' }, { where: { companyId: tenant.companyId, providerCode: 'financing-sandbox', status: ['ACTIVE', 'DRAFT', 'PAUSED', 'AUTH_FAILED'] }, transaction: t });
    const conta = await accounts.registerProviderAccount({ groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'sandbox', label: `Conta D240 ${uniqueSuffix()}`, secretRef: 'vault:nayara/fin/sandbox' }, tenant.userId, t);
    const connection = await IntegrationConnection.findByPk(conta.id, { transaction: t });
    assert.ok(connection, 'a conta é uma connection do registro');
    assert.equal(connection.providerCode, 'financing-sandbox');
    assert.equal((await IntegrationProvider.findByPk(connection.providerCode, { transaction: t })).domain, 'FINANCING');
    assert.equal(conta.providerCode, 'sandbox', 'a resposta mantém o formato e o código antigos');
    assert.ok((await accounts.listProviderAccounts(tenant.groupId, tenant.companyId, t)).some((c) => c.id === conta.id));
    const [[legado]] = await sequelize.query('SELECT count(*)::int AS n FROM correspondent.provider_accounts WHERE id = :id', { replacements: { id: conta.id }, transaction: t });
    assert.equal(legado.n, 0, 'nada novo na tabela antiga');
    assert.equal(/const \{[^}]*\bProviderAccount\b[^}]*\} = require/.test(fs.readFileSync(path.join(RAIZ, 'src/features/correspondent/providerAccounts.service.js'), 'utf8')), false, 'o serviço não importa mais o modelo antigo');
    // o adapter do Correspondente é o da connection cadastrada (a ativa do provider), não uma instância solta
    const espiao = espiarRegistro();
    try {
      await resolveFinancingProviderAdapter(tenant, t);
      assert.deepEqual(espiao.visto.connections, [conta.id]);
    } finally { espiao.restaurar(); }
  });
});

test('financiamento_tabelas_antigas_somente_leitura', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    for (const [tabela, colunas, valores] of [
      ['provider_accounts', 'group_id, company_id, provider_code, label, secret_ref', ':g, :c, \'sandbox\', \'x\', \'vault:x/y/z\''],
      ['webhook_inbox', 'group_id, company_id, provider_code, external_event_id', ':g, :c, \'sandbox\', \'e1\''],
      ['integration_errors', 'group_id, company_id, provider_code, error_code, message', ':g, :c, \'sandbox\', \'X\', \'x\''],
    ]) {
      await assert.rejects(
        sequelize.transaction({ transaction: t }, (sp) => sequelize.query(`INSERT INTO correspondent.${tabela} (${colunas}) VALUES (${valores})`, { replacements: { g: tenant.groupId, c: tenant.companyId }, transaction: sp })),
        /somente leitura|read.only|legado/i, `correspondent.${tabela} recusa escrita`,
      );
      const [[leitura]] = await sequelize.query(`SELECT count(*)::int AS n FROM correspondent.${tabela}`, { transaction: t });
      assert.ok(Number.isInteger(leitura.n), `correspondent.${tabela} continua consultável`);
    }
  });
});
