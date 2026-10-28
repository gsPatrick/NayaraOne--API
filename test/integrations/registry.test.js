'use strict';

// Marco 9, M9-D200 — registro de integração (integration.providers e integration.connections): provedores, unicidade, RLS e segredo embutido.
// Roda em banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... (a prova de
// concorrência COMMITA dados e depois apaga).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, withRollbackTenantTransaction, uniqueSuffix } = require('../testHelpers');
const { IntegrationConnection, IntegrationProvider } = require('../../src/models');
const registry = require('../../src/features/integrations/registry/registry.service');
const { setupEnv, teardownEnv, novaConexao, comPlataforma, recusa } = require('../helpers/integrationsRegistryEnv');

let tenant;
let ctx;
let otherTenant;

before(async () => {
  ({ tenant, ctx, otherTenant } = await setupEnv());
});

after(async () => {
  await teardownEnv(tenant);
  await sequelize.close();
});

test('providers_constraints_lista_fechada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await comPlataforma(transaction);
    const insere = async (over) => {
      await sequelize.query('SAVEPOINT s1', { transaction });
      try {
        await sequelize.query(
          `INSERT INTO integration.providers (code, display_name, domain, capabilities, supported_versions, criticality, status, sandbox_available)
           VALUES (:code, 'X', :domain, '[]', '["v1"]', :criticality, :status, true)`,
          { transaction, replacements: { code: 'qa-m9-x', domain: 'BANK', criticality: 'LOW', status: 'ACTIVE', ...over } }
        );
        await sequelize.query('RELEASE SAVEPOINT s1', { transaction });
        return true;
      } catch (err) {
        await sequelize.query('ROLLBACK TO SAVEPOINT s1', { transaction });
        return false;
      }
    };
    assert.equal(await insere({ domain: 'XPTO' }), false, 'domain fora da lista fechada');
    assert.equal(await insere({ criticality: 'EXTREME' }), false, 'criticality fora da lista');
    assert.equal(await insere({ status: 'ARCHIVED' }), false, 'status fora da lista');
    assert.equal(await insere({ code: 'QA_M9_MAIUSCULO' }), false, 'code só minúsculas');
    assert.equal(await insere({}), true, 'linha válida entra');
    // DELETE proibido: sem política de DELETE o runtime não apaga nenhuma linha.
    const [, apagou] = await sequelize.query("DELETE FROM integration.providers WHERE code = 'qa-m9-x'", { transaction });
    assert.equal(apagou.rowCount, 0);
    assert.ok(await IntegrationProvider.findByPk('qa-m9-x', { transaction }));
  });
  // Sem a marca de administração de plataforma o runtime não escreve no catálogo.
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(sequelize.query(
      `INSERT INTO integration.providers (code, display_name, domain, capabilities, supported_versions, criticality, sandbox_available)
       VALUES ('qa-m9-y', 'Y', 'BANK', '[]', '[]', 'LOW', true)`, { transaction }));
  });
});

test('connections_unique_active_por_ambiente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const a = await registry.createConnection(novaConexao(), ctx, transaction);
    const b = await registry.createConnection(novaConexao(), ctx, transaction);
    await registry.transitionConnection(a.id, 'ACTIVE', ctx, transaction);
    await recusa(registry.transitionConnection(b.id, 'ACTIVE', ctx, transaction), 'INTEGRATION_CONNECTION_DUPLICATE_ACTIVE', 409);
    assert.equal((await IntegrationConnection.findByPk(a.id, { transaction })).status, 'ACTIVE');
    assert.equal((await IntegrationConnection.findByPk(b.id, { transaction })).status, 'DRAFT');
    // Ambiente diferente não conflita.
    const c = await registry.createConnection(novaConexao({ environment: 'HOMOLOG' }), ctx, transaction);
    await registry.transitionConnection(c.id, 'ACTIVE', ctx, transaction);
    // Rótulo repetido no mesmo provider/ambiente é recusado.
    await recusa(registry.createConnection(novaConexao({ label: a.label }), ctx, transaction), 'INTEGRATION_CONNECTION_DUPLICATE_LABEL', 409);
  });
  // O banco também impede duas ACTIVE (índice parcial), mesmo por fora do serviço.
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const a = await registry.createConnection(novaConexao(), ctx, transaction);
    const b = await registry.createConnection(novaConexao(), ctx, transaction);
    await sequelize.query("UPDATE integration.connections SET status = 'ACTIVE' WHERE id = :id", { transaction, replacements: { id: a.id } });
    await assert.rejects(sequelize.query("UPDATE integration.connections SET status = 'ACTIVE' WHERE id = :id", { transaction, replacements: { id: b.id } }), /connections_one_active|duplicate key/);
  });
});

test('connections_rls_isolamento_entre_empresas', async (t) => {
  if (!otherTenant) return t.skip('só há uma empresa neste banco');
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const a = await registry.createConnection(novaConexao(), ctx, transaction);
    await sequelize.query('SET LOCAL app.company_id = :c', { transaction, replacements: { c: otherTenant.companyId } });
    await sequelize.query('SET LOCAL app.group_id = :g', { transaction, replacements: { g: otherTenant.groupId } });
    assert.equal(await IntegrationConnection.findByPk(a.id, { transaction }), null);
    assert.equal((await registry.listConnections(otherTenant, {}, transaction)).length, 0);
    await recusa(registry.getConnection(a.id, otherTenant, transaction), 'INTEGRATION_CONNECTION_NOT_FOUND', 404);
    await recusa(registry.updateConnection(a.id, { label: 'invasao' }, otherTenant, transaction), 'INTEGRATION_CONNECTION_NOT_FOUND', 404);
    const [, meta] = await sequelize.query("UPDATE integration.connections SET label = 'invasao' WHERE id = :id", { transaction, replacements: { id: a.id } });
    assert.equal(meta.rowCount, 0);
    // Gravar em nome da empresa A estando logado na B é recusado pela política.
    await assert.rejects(IntegrationConnection.create({ ...novaConexao(), groupId: tenant.groupId, companyId: tenant.companyId }, { transaction }));
  });
});

test('connections_segredo_embutido_recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const maus = [
      { config: { apiKey: 'abc123def456' } },
      { config: { nested: { client_secret: 'xyz' } } },
      { config: { cabecalho: 'Z'.repeat(64) } },
      { config: { chave: 'deadbeef'.repeat(8) } },
      { config: { pem: '-----BEGIN PRIVATE KEY-----\nabc' } },
      { policy: { auth: { password: 'senha' } } },
      { policy: { lista: [{ webhook_secret: 'w' }] } },
      // Reabertura: chave de segredo com valor não vazio de qualquer tipo (número, booleano, lista).
      { config: { apiKey: 123456789 } },
      { config: { api_key: true } },
      { config: { nested: { client_secret: 42 } } },
      { config: { token: [123, 456] } },
      { config: { password: { valor: 987654 } } },
      { policy: { auth: { password: 0 } } },
      { policy: { lista: [{ webhook_secret: false }] } },
      { policy: { privateKey: 1 } },
    ];
    for (const m of maus) {
      await recusa(
        registry.createConnection(novaConexao({ configJson: m.config || {}, policyJson: m.policy || {} }), ctx, transaction),
        'INTEGRATION_SECRET_IN_CONFIG',
        422
      );
    }
    const antes = await IntegrationConnection.count({ where: { companyId: tenant.companyId }, transaction });
    // Na alteração também.
    const ok = await registry.createConnection(novaConexao({ configJson: { baseUrl: 'https://api.exemplo.com/v1', accountId: '12345', token: '' } }), ctx, transaction);
    await recusa(registry.updateConnection(ok.id, { configJson: { apiKey: 'abc' } }, ctx, transaction), 'INTEGRATION_SECRET_IN_CONFIG', 422);
    assert.deepEqual((await IntegrationConnection.findByPk(ok.id, { transaction })).configJson, { baseUrl: 'https://api.exemplo.com/v1', accountId: '12345', token: '' });
    assert.equal(await IntegrationConnection.count({ where: { companyId: tenant.companyId }, transaction }), antes + 1);
    // Valores realmente vazios sob chave de segredo continuam aceitos.
    await registry.createConnection(novaConexao({ label: `QA-M9 vazios ${uniqueSuffix()}`, configJson: { token: null, apiKey: '', secret: [], password: {} } }), ctx, transaction);
    // Catálogo: política padrão do provider também é varrida.
    await recusa(registry.createProvider({ code: `qa-m9-seg-${uniqueSuffix()}`.toLowerCase(), displayName: 'QA-M9', domain: 'MESSAGING', capabilities: ['sendText'], supportedVersions: ['v1'], criticality: 'LOW', sandboxAvailable: true, defaultPolicyJson: { apiKey: 123456789 } }, ctx, transaction), 'INTEGRATION_SECRET_IN_CONFIG', 422);
    // secretRef não pode ser o próprio segredo.
    await recusa(registry.createConnection(novaConexao({ secretRef: 'Bearer abc.def' }), ctx, transaction), 'INTEGRATION_SECRET_IN_CONFIG', 422);
    // Campo de segredo solto no corpo.
    await recusa(registry.createConnection({ ...novaConexao(), apiKey: 'abc' }, ctx, transaction), 'INTEGRATION_SECRET_IN_CONFIG', 422);
  });
});
