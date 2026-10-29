'use strict';

// Apoio dos testes do circuit breaker (M9-D217): conexão ativa nova por teste, leitura da linha de saúde e chamadas do breaker em transação com COMMIT.
const { sequelize, comTenant, carregarTenants, ctxDe, conexaoAtiva, config, limparConfig } = require('./m9d214Env');
const { IntegrationConnection } = require('../../../src/models');
const breaker = require('../../../src/features/integrations/health/circuitBreaker');
const health = require('../../../src/features/integrations/health');

const CHAVES = ['integration.circuit.failure_threshold', 'integration.circuit.cooldown_s', 'integration.circuit.half_open_max_calls', 'integration.circuit.close_after_successes', 'integration.circuit.half_open_recheck_s'];

/** Chama o breaker com a conexão carregada dentro da transação da empresa (commit ao final). */
const comConexao = (tenant, id, fn) => comTenant(tenant, async (t) => fn(await IntegrationConnection.findByPk(id, { transaction: t }), t));
const admitir = (tenant, id, opts = {}) => comConexao(tenant, id, (c, t) => breaker.admitCall(c, ctxDe(tenant), t, opts));
const resultado = (tenant, id, opts) => comConexao(tenant, id, (c, t) => breaker.recordCallResult(c, ctxDe(tenant), t, opts));
const falhar = async (tenant, id, n, errorClass = 'TRANSIENT', opts = {}) => { for (let i = 0; i < n; i += 1) await resultado(tenant, id, { ok: false, errorClass, ...opts }); };

/** Linha atual da saúde, direto do banco. */
const linha = (tenant, id) => comTenant(tenant, async (t) => (await sequelize.query(
  'SELECT * FROM integration.provider_health WHERE connection_id = :id AND window_minutes = 0', { replacements: { id }, transaction: t },
))[0][0] || null);

/** Põe o circuito num estado conhecido (cenário), sem passar pela máquina. */
const forcarCircuito = (tenant, id, patch) => comTenant(tenant, async (t) => {
  const c = await IntegrationConnection.findByPk(id, { transaction: t });
  await health.updateCircuitState(c.id, patch, t);
});

const errosCircuito = (tenant, id) => comTenant(tenant, async (t) => (await sequelize.query(
  "SELECT * FROM integration.integration_errors WHERE connection_id = :id AND error_code = 'CIRCUIT_OPEN' ORDER BY created_at", { replacements: { id }, transaction: t },
))[0]);

const limparCircuito = (tenant) => limparConfig(tenant, CHAVES);

module.exports = {
  sequelize, comTenant, carregarTenants, ctxDe, conexaoAtiva, config, limparConfig, limparCircuito, admitir, resultado, falhar, linha, forcarCircuito, errosCircuito, comConexao, breaker, health,
};
