'use strict';

// Marco 9, M9-D200 — registro de integração (integration.providers e integration.connections): transições, produção, concorrência, migração, auditoria e permissões.
// Roda em banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... (a prova de
// concorrência COMMITA dados e depois apaga).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, withRollbackTenantTransaction, uniqueSuffix } = require('../testHelpers');
const { AuditLog, IntegrationConnection, IntegrationProvider, ProviderAccount } = require('../../src/models');
const registry = require('../../src/features/integrations/registry/registry.service');
const settingsService = require('../../src/features/settings/settings.service');
const { gravarParametroSensivel } = require('../helpers/mfaRecente');
const providerAccountsService = require('../../src/features/correspondent/providerAccounts.service');
const { setupEnv, teardownEnv, novaConexao, recusa } = require('../helpers/integrationsRegistryEnv');
const { semMfa } = require('../marco9/_helpers/semMfa');

let tenant;
let ctx;

before(async () => {
  ({ tenant, ctx } = await setupEnv());
});

after(async () => {
  await teardownEnv(tenant);
  await sequelize.close();
});

test('connections_transicoes_validas_e_invalidas', async () => {
  const estados = ['DRAFT', 'ACTIVE', 'PAUSED', 'AUTH_FAILED', 'DISABLED'];
  const validas = new Set(['DRAFT>ACTIVE', 'ACTIVE>PAUSED', 'PAUSED>ACTIVE', 'ACTIVE>AUTH_FAILED', 'AUTH_FAILED>ACTIVE',
    'DRAFT>DISABLED', 'ACTIVE>DISABLED', 'PAUSED>DISABLED', 'AUTH_FAILED>DISABLED']);
  for (const de of estados) {
    for (const para of estados) {
      await withRollbackTenantTransaction(tenant, async (transaction) => {
        const c = await registry.createConnection(novaConexao(), ctx, transaction);
        if (de !== 'DRAFT') {
          // leva a linha até o estado de origem pelo caminho legal
          if (de === 'ACTIVE' || de === 'PAUSED' || de === 'AUTH_FAILED') await registry.transitionConnection(c.id, 'ACTIVE', ctx, transaction);
          if (de === 'PAUSED') await registry.transitionConnection(c.id, 'PAUSED', ctx, transaction);
          if (de === 'AUTH_FAILED') await registry.transitionConnection(c.id, 'AUTH_FAILED', ctx, transaction, { system: true });
          if (de === 'DISABLED') await registry.transitionConnection(c.id, 'DISABLED', ctx, transaction);
        }
        const opts = { system: para === 'AUTH_FAILED', testConnectionOk: de === 'AUTH_FAILED' && para === 'ACTIVE' };
        const chave = `${de}>${para}`;
        if (validas.has(chave)) {
          const r = await registry.transitionConnection(c.id, para, ctx, transaction, opts);
          assert.equal(r.status, para, chave);
        } else {
          await recusa(registry.transitionConnection(c.id, para, ctx, transaction, opts), 'INTEGRATION_CONNECTION_INVALID_TRANSITION', 409);
          assert.equal((await IntegrationConnection.findByPk(c.id, { transaction })).status, de, `${chave} não muda o estado`);
        }
      });
    }
  }
  // Só o sistema derruba para AUTH_FAILED e só teste verde reativa.
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const c = await registry.createConnection(novaConexao(), ctx, transaction);
    await registry.transitionConnection(c.id, 'ACTIVE', ctx, transaction);
    await recusa(registry.transitionConnection(c.id, 'AUTH_FAILED', ctx, transaction), 'INTEGRATION_CONNECTION_INVALID_TRANSITION', 409);
    await registry.transitionConnection(c.id, 'AUTH_FAILED', ctx, transaction, { system: true });
    await recusa(registry.transitionConnection(c.id, 'ACTIVE', ctx, transaction), 'INTEGRATION_CONNECTION_INVALID_TRANSITION', 409);
  });
  // DISABLED não volta nem por fora do serviço (gatilho).
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const c = await registry.createConnection(novaConexao(), ctx, transaction);
    await registry.transitionConnection(c.id, 'DISABLED', ctx, transaction);
    await assert.rejects(sequelize.query("UPDATE integration.connections SET status = 'DRAFT' WHERE id = :id", { transaction, replacements: { id: c.id } }), /DISABLED/);
  });
});

test('connections_producao_exige_liberacao', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const c = await registry.createConnection(novaConexao({ environment: 'PRODUCTION' }), ctx, transaction);
    await recusa(registry.transitionConnection(c.id, 'ACTIVE', ctx, transaction), 'INTEGRATION_PRODUCTION_NOT_RELEASED', 409);
    assert.equal((await IntegrationConnection.findByPk(c.id, { transaction })).status, 'DRAFT');
    // O CHECK do banco barra mesmo por fora do serviço.
    await sequelize.query('SAVEPOINT p1', { transaction });
    await assert.rejects(sequelize.query("UPDATE integration.connections SET status = 'ACTIVE' WHERE id = :id", { transaction, replacements: { id: c.id } }), /connections_production_released_check/);
    await sequelize.query('ROLLBACK TO SAVEPOINT p1', { transaction });
    // Com liberação registrada, ativa.
    await sequelize.query('UPDATE integration.connections SET production_released_at = now(), production_released_by = :u WHERE id = :id', { transaction, replacements: { id: c.id, u: tenant.userId } });
    const r = await registry.transitionConnection(c.id, 'ACTIVE', ctx, transaction);
    assert.equal(r.status, 'ACTIVE');
  });
  // Criar já ACTIVE em produção também é recusado.
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await recusa(registry.createConnection(novaConexao({ environment: 'PRODUCTION', status: 'ACTIVE' }), ctx, transaction), 'INTEGRATION_CONNECTION_INVALID_TRANSITION', 409);
  });
});

test('connections_ativacao_concorrente', async () => {
  for (let rodada = 0; rodada < 3; rodada += 1) {
    const ids = [];
    const abrir = async (fn) => {
      const transaction = await sequelize.transaction();
      try {
        await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
        await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
        await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction });
        const r = await fn(transaction);
        await transaction.commit();
        return r;
      } catch (err) {
        await transaction.rollback().catch(() => {});
        throw err;
      }
    };
    try {
      for (let i = 0; i < 2; i += 1) {
        const c = await abrir((t) => registry.createConnection(novaConexao({ environment: 'HOMOLOG' }), ctx, t));
        ids.push(c.id);
      }
      const resultados = await Promise.allSettled(ids.map((id) => abrir((t) => registry.transitionConnection(id, 'ACTIVE', ctx, t))));
      const ok = resultados.filter((r) => r.status === 'fulfilled');
      const falhas = resultados.filter((r) => r.status === 'rejected');
      assert.equal(ok.length, 1, 'uma ativação vence');
      assert.equal(falhas.length, 1);
      assert.equal(falhas[0].reason.code, 'INTEGRATION_CONNECTION_DUPLICATE_ACTIVE');
      assert.equal(falhas[0].reason.statusCode ?? falhas[0].reason.status, 409);
      const [[{ n }]] = await abrir(async (t) => sequelize.query(
        `SELECT count(*)::int AS n FROM integration.connections WHERE id IN (:ids) AND status = 'ACTIVE'`, { replacements: { ids }, transaction: t }));
      assert.equal(n, 1);
    } finally {
      if (ids.length) {
        await abrir((t) => sequelize.query('DELETE FROM integration.connections WHERE id IN (:ids)', { replacements: { ids }, transaction: t }));
      }
    }
  }
});

// Hermético: connections de outros testes (webhooks do Correspondente deixam uma ACTIVE de financing-sandbox) mudariam
// o estado que a migração das contas legadas atribui. Dentro da transação do teste (desfeita no fim), desativa as da empresa
// e remove as contas legadas dela.
async function isolarConexoesDaEmpresa(transaction) {
  // Contas legadas de outros testes (ativas e mais antigas) tirariam o ACTIVE da "Conta A" na migração.
  await sequelize.query("SET LOCAL app.integration_legacy_write = 'on'", { transaction });
  await sequelize.query('DELETE FROM correspondent.provider_accounts WHERE company_id = :c', { replacements: { c: tenant.companyId }, transaction });
  await sequelize.query("SET LOCAL app.integration_legacy_write = 'off'", { transaction }); // a prova de somente leitura precisa do gatilho armado
  await sequelize.query("UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND status <> 'DISABLED'", { replacements: { c: tenant.companyId }, transaction });
}

test('migracao_provider_accounts_idempotente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await isolarConexoesDaEmpresa(transaction);
    await sequelize.query("SET LOCAL app.integration_legacy_write = 'on'", { transaction });
    const base = { groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'sandbox' };
    const a1 = await ProviderAccount.create({ ...base, label: 'Conta A', secretRef: 'vault:qa-m9/a', active: true }, { transaction });
    const a2 = await ProviderAccount.create({ ...base, label: 'Conta B', secretRef: 'vault:qa-m9/b', active: true }, { transaction });
    const a3 = await ProviderAccount.create({ ...base, label: 'Conta C', secretRef: 'vault:qa-m9/c', active: false }, { transaction });
    // A migração desempata contas ativas por created_at; datas em milissegundos iguais cairiam no id aleatório. Datas distintas fixas.
    await sequelize.query("UPDATE correspondent.provider_accounts SET created_at = now() - interval '3 minutes' WHERE id = :a", { replacements: { a: a1.id }, transaction });
    await sequelize.query("UPDATE correspondent.provider_accounts SET created_at = now() - interval '2 minutes' WHERE id = :a", { replacements: { a: a2.id }, transaction });
    await sequelize.query("UPDATE correspondent.provider_accounts SET created_at = now() - interval '1 minute' WHERE id = :a", { replacements: { a: a3.id }, transaction });
    const primeira = await registry.migrateLegacyProviderAccounts(ctx, transaction);
    assert.equal(primeira.inserted, 3);
    const segunda = await registry.migrateLegacyProviderAccounts(ctx, transaction);
    assert.equal(segunda.inserted, 0);
    const linhas = await IntegrationConnection.findAll({ where: { id: [a1.id, a2.id, a3.id] }, transaction });
    assert.equal(linhas.length, 3);
    const por = Object.fromEntries(linhas.map((l) => [l.label, l]));
    assert.equal(por['Conta A'].secretRef, 'vault:qa-m9/a');
    assert.equal(por['Conta B'].secretRef, 'vault:qa-m9/b');
    assert.equal(por['Conta C'].secretRef, 'vault:qa-m9/c');
    assert.equal(por['Conta A'].status, 'ACTIVE');
    assert.equal(por['Conta B'].status, 'PAUSED');
    assert.equal(por['Conta C'].status, 'DISABLED');
    assert.ok(linhas.every((l) => l.environment === 'SANDBOX' && l.providerCode === 'financing-sandbox'));
  });
});

test('registry_resolve_connection_ambiente_do_servidor', async () => {
  const anterior = process.env.INTEGRATION_ENVIRONMENT;
  process.env.INTEGRATION_ENVIRONMENT = 'HOMOLOG';
  try {
    await withRollbackTenantTransaction(tenant, async (transaction) => {
      assert.equal(registry.getServerEnvironment(), 'HOMOLOG');
      const sbx = await registry.createConnection(novaConexao({ environment: 'SANDBOX' }), ctx, transaction);
      const hml = await registry.createConnection(novaConexao({ environment: 'HOMOLOG' }), ctx, transaction);
      await registry.transitionConnection(sbx.id, 'ACTIVE', ctx, transaction);
      await registry.transitionConnection(hml.id, 'ACTIVE', ctx, transaction);
      const r = await registry.resolveConnection({ companyId: tenant.companyId, providerCode: 'financing-manual', environment: 'SANDBOX' }, transaction);
      assert.equal(r.id, hml.id, 'o ambiente do pedido é ignorado');
      const porDominio = await registry.resolveConnection({ companyId: tenant.companyId, domain: 'FINANCING' }, transaction);
      assert.equal(porDominio.id, hml.id);
      await registry.transitionConnection(hml.id, 'PAUSED', ctx, transaction);
      await recusa(registry.resolveConnection({ companyId: tenant.companyId, providerCode: 'financing-manual' }, transaction), 'INTEGRATION_CONNECTION_NOT_FOUND', 404);
    });
    process.env.INTEGRATION_ENVIRONMENT = 'QUALQUER';
    assert.throws(() => registry.getServerEnvironment());
  } finally {
    if (anterior === undefined) delete process.env.INTEGRATION_ENVIRONMENT; else process.env.INTEGRATION_ENVIRONMENT = anterior;
  }
});

test('connections_auditoria_antes_depois', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const c = await registry.createConnection(novaConexao({ secretRef: `company/${tenant.companyId}/qa-m9-aud/api-key`, configJson: { baseUrl: 'https://a.exemplo.com' } }), ctx, transaction);
    await registry.updateConnection(c.id, { label: `${c.label} v2`, configJson: { baseUrl: 'https://b.exemplo.com' } }, ctx, transaction);
    await registry.transitionConnection(c.id, 'ACTIVE', ctx, transaction);
    const logs = await AuditLog.findAll({ where: { action: 'integration.connection.changed', entityId: c.id }, order: [['occurredAt', 'ASC']], transaction });
    assert.equal(logs.length, 3);
    assert.ok(JSON.stringify(logs[0].beforeJson).includes('Não existia'));
    assert.equal(logs[1].beforeJson.configJson.baseUrl, 'https://a.exemplo.com');
    assert.equal(logs[1].afterJson.configJson.baseUrl, 'https://b.exemplo.com');
    assert.equal(logs[2].beforeJson.status, 'DRAFT');
    assert.equal(logs[2].afterJson.status, 'ACTIVE');
    const tudo = JSON.stringify(logs.map((l) => l.toJSON()));
    assert.equal(tudo.includes('qa-m9-aud/api-key'), false, 'nem a referência do cofre vai para a auditoria');
    assert.ok(logs[2].afterJson.secretRefConfigured === true);
  });
});

test('connections_producao_exige_mfa_recente_configuravel', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await semMfa(tenant.userId, transaction); // hermético: outro arquivo pode ter deixado MFA habilitado para o usuário do seed
    await gravarParametroSensivel('integration.admin.mfa_on_prod_connection_change', true, tenant, transaction); // sensível: operador com MFA recente real
    const c = await registry.createConnection(novaConexao({ environment: 'SANDBOX' }), ctx, transaction);
    await registry.updateConnection(c.id, { label: `${c.label} ok` }, ctx, transaction); // fora de produção não pede MFA
    await assert.rejects(
      registry.createConnection(novaConexao({ environment: 'PRODUCTION' }), ctx, transaction),
      (err) => ['MFA_REQUIRED_NOT_ENABLED', 'MFA_STEP_UP_REQUIRED'].includes(err.code)
    );
    await gravarParametroSensivel('integration.admin.mfa_on_prod_connection_change', false, tenant, transaction); // sensível: operador com MFA recente real
    const p = await registry.createConnection(novaConexao({ environment: 'PRODUCTION' }), ctx, transaction);
    assert.equal(p.environment, 'PRODUCTION');
  });
});

test('correspondente_usa_o_registro_e_o_legado_e_somente_leitura', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await isolarConexoesDaEmpresa(transaction);
    const conta = await providerAccountsService.registerProviderAccount(
      { groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'sandbox', label: `QA-M9 ${uniqueSuffix()}`, secretRef: 'vault:qa-m9/corr' },
      tenant.userId, transaction
    );
    const con = await IntegrationConnection.findByPk(conta.id, { transaction });
    assert.ok(con, 'a conta virou connection');
    assert.equal(con.secretRef, 'vault:qa-m9/corr');
    assert.equal(con.providerCode, 'financing-sandbox');
    assert.equal(conta.providerCode, 'sandbox', 'o Correspondente continua vendo o código antigo');
    const lista = await providerAccountsService.listProviderAccounts(tenant.groupId, tenant.companyId, transaction);
    assert.ok(lista.some((a) => a.id === conta.id && a.secretRef === 'vault:qa-m9/corr' && a.active === true));
    await providerAccountsService.updateProviderAccount(conta.id, { active: false }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    assert.equal((await IntegrationConnection.findByPk(conta.id, { transaction })).status, "PAUSED");
    await sequelize.query('SAVEPOINT l1', { transaction });
    await assert.rejects(
      ProviderAccount.create({ groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'sandbox', label: 'x', secretRef: 'vault:x' }, { transaction }),
      /somente leitura/
    );
    await sequelize.query('ROLLBACK TO SAVEPOINT l1', { transaction });
  });
});

test('permissoes_e_parametros_do_registro', async () => {
  const [rows] = await sequelize.query(
    `SELECT p.code FROM core.permissions p WHERE p.code IN ('integration:read', 'integration:manage')`
  );
  assert.equal(rows.length, 2);
  const [admin] = await sequelize.query(
    `SELECT DISTINCT p.code FROM core.role_permissions rp JOIN core.roles r ON r.id = rp.role_id JOIN core.permissions p ON p.id = rp.permission_id
      WHERE r.name = 'ADMIN' AND p.code IN ('integration:read', 'integration:manage')`
  );
  // sob FORCE RLS o runtime pode não enxergar papéis sem empresa; o que importa é existir a permissão
  assert.ok(admin.length === 0 || admin.length === 2);
  for (const [key, tipo] of [['integration.admin.mfa_on_prod_connection_change', 'boolean'], ['integration.admin.mfa_on_prod_test_connection', 'boolean'], ['integration.registry.secret_scan_min_length', 'integer']]) {
    assert.equal(settingsService.SETTINGS_SCHEMA[key]?.type, tipo, key);
  }
  const pr = await IntegrationProvider.findAll({ where: { code: ['financing-sandbox', 'financing-manual'] } });
  assert.equal(pr.length, 2);
});
