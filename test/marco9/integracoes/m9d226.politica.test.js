'use strict';

// Marco 9, M9-D226 — política de contingência: prazo padrão por modo (queue_max_age_h), validação ao salvar e parâmetros do administrador.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d226Env');
const { validatePolicyJson } = require('../../../src/features/integrations/dispatch/retry/retry.limits');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

const { sequelize, carregarTenants, comTenant, ctxDe, contingency, config, limparConfig } = env;
let tenant;

before(async () => { ({ tenant } = await carregarTenants()); });
beforeEach(() => limparConfig(tenant, env.CHAVES));
after(async () => { await limparConfig(tenant, env.CHAVES); await sequelize.close(); });

const politica = (domain, providerCode) => comTenant(tenant, (t) => contingency.resolvePolicyFor(ctxDe(tenant), { domain, providerCode }, t));

test('contingencia_queue_max_age_padrao_por_modo', async () => {
  const esperado = {
    MESSAGING: ['QUEUE_AND_ALTERNATE', 24], PORTAL: ['KEEP_INTERNAL_AND_REPROCESS', 24], SIGNATURE: ['PRESERVE_AND_ALTERNATE_FLOW', 24],
    FINANCING: ['QUEUE_QUERY_OR_ALTERNATE_PROVIDER', 24], IDENTITY: ['PRESERVE_AND_ALTERNATE_FLOW', 24], BANK: ['NO_ASSUME_AND_QUERY', 72], AI: ['DEGRADE_TO_DETERMINISTIC', null],
  };
  for (const [domain, [mode, horas]] of Object.entries(esperado)) {
    const p = await politica(domain);
    assert.deepEqual([p.mode, p.queueMaxAgeH], [mode, horas], domain);
  }
  assert.equal(await politica('EMAIL'), null, 'família sem caso na seção 18 não tem modo');
  // parâmetros do administrador: o do modo e a régua única do banco
  await config(tenant, 'integration.contingency.queue_max_age_h.QUEUE_AND_ALTERNATE', 36);
  await config(tenant, 'integration.bank.max_pending_hours', 48);
  assert.equal((await politica('MESSAGING')).queueMaxAgeH, 36);
  assert.equal((await politica('BANK')).queueMaxAgeH, 48);
  // a política do fornecedor/connection sobrescreve o modo (menos o banco, que só lê a régua única, e a IA, que não tem fila)
  const c = await env.conexaoDe(tenant, 'messaging-sandbox', { contingencia: { queue_max_age_h: 12, mode: 'KEEP_INTERNAL_AND_REPROCESS' } });
  const efetiva = await comTenant(tenant, (t) => contingency.resolveContingencyPolicy(ctxDe(tenant), c, t));
  assert.deepEqual([efetiva.mode, efetiva.queueMaxAgeH], ['KEEP_INTERNAL_AND_REPROCESS', 12]);
  const b = await env.conexaoDe(tenant, 'bank-sandbox', { contingencia: { queue_max_age_h: 1 } });
  assert.equal((await comTenant(tenant, (t) => contingency.resolveContingencyPolicy(ctxDe(tenant), b, t))).queueMaxAgeH, 48);
  await env.desativarConexoesDeTeste(tenant);
});

test('politica_contingency_e_validada_ao_salvar', () => {
  const invalida = (contingency, trecho) => assert.throws(() => validatePolicyJson({ contingency }), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_POLICY_INVALID' && JSON.stringify(e.details).includes(trecho));
  validatePolicyJson({ contingency: { mode: 'NO_ASSUME_AND_QUERY', queue_max_age_h: 72, alternate_connection_id: null, manual_task_assignee_role: 'Financeiro', notify_roles: ['ADMIN', 'Diretoria'] } });
  invalida({ mode: 'INVENTADO' }, 'contingency.mode');
  invalida({ queue_max_age_h: 0 }, 'contingency.queue_max_age_h');
  invalida({ queue_max_age_h: 100000 }, 'contingency.queue_max_age_h');
  invalida({ alternate_connection_id: 'não-é-uuid' }, 'contingency.alternate_connection_id');
  invalida({ notify_roles: [] }, 'contingency.notify_roles');
  invalida({ manual_task_assignee_role: 'x' }, 'contingency.manual_task_assignee_role');
  invalida({ campo_novo: 1 }, 'campo desconhecido');
  invalida('texto', 'esperado um objeto');
});

test('parametros_da_contingencia_estao_no_schema_de_configuracoes', () => {
  [
    'integration.contingency.recovery_checks', 'integration.contingency.queue_max_age_h.QUEUE_AND_ALTERNATE', 'integration.contingency.queue_max_age_h.KEEP_INTERNAL_AND_REPROCESS',
    'integration.contingency.queue_max_age_h.PRESERVE_AND_ALTERNATE_FLOW', 'integration.contingency.queue_max_age_h.QUEUE_QUERY_OR_ALTERNATE_PROVIDER', 'integration.bank.max_pending_hours',
    'integration.contingency.manual_task_assignee_role', 'integration.contingency.notify_roles', 'integration.contingency.manual_task_due_h', 'integration.contingency.drain_batch_size',
    'integration.contingency.manual_task_batch_size',
  ].forEach((chave) => assert.ok(SETTINGS_SCHEMA[chave], `${chave} precisa estar declarado`));
  assert.throws(() => SETTINGS_SCHEMA['integration.contingency.notify_roles'].validate('integration.contingency.notify_roles', 'x'), /lista de nomes/);
});
