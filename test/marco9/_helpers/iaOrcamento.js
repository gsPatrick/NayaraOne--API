'use strict';

const { gravarParametroSensivel } = require('../../helpers/mfaRecente');

// Fábricas e provider sandbox do orçamento da NAY (M9-D014). Rodam com nayara_runtime (RLS real); os testes com rollback usam
// withRollbackTenantTransaction e só os de concorrência gravam de verdade (cluster descartável).

const { uid, q, sequelize } = require('../../helpers/aiRuns');
const repo = require('../../../src/features/ai/readmodels/budgetSupport.readmodel');
const budgets = require('../../../src/features/ai/budgets');
const { monthPeriodOf } = require('../../../src/features/ai/budgets/budgets.period');
const { upsertSetting, SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

/** Meio do mês corrente em UTC: dentro do período mensal de America/Sao_Paulo e longe das viradas. */
const AGORA = new Date('2026-10-15T15:00:00Z');
const MES_QUE_VEM = new Date('2026-11-10T15:00:00Z');

/** Código de agente único por teste: linhas gravadas de verdade nunca se cruzam com as de outro teste. */
const agente = (prefixo = 'M9D014') => `${prefixo}_${uid().replace(/-/g, '').slice(0, 10).toUpperCase()}`;

/** Provider sandbox determinístico: o custo da chamada vem do texto `[[CUSTO:x]]` do pedido. */
function sandboxCusto(prompt) {
  const m = /\[\[CUSTO:(\d+(?:\.\d+)?)\]\]/.exec(prompt);
  return { text: 'Resposta do sandbox.', cost: m ? m[1] : '0' };
}

async function criarOrcamento(ctx, tx, { agentCode = null, modelClass = null, limit = '200.00', thresholds = null, actionAt100 = null, at = AGORA } = {}) {
  return repo.insertBudget(ctx, { agentCode, modelClass, limitAmount: limit, thresholds, actionAt100, period: monthPeriodOf(at) }, tx);
}

/** Uma chamada de modelo pelo portão: reserva a estimativa (padrão = custo do pedido), chama o sandbox e acerta o custo real. */
function gastar(ctx, tx, { agentCode, criticality = 'NON_CRITICAL', routingPath = 'SMALL_MODEL', pedido = '[[CUSTO:10]]', estimate, at = AGORA, falhar = false }) {
  const custo = sandboxCusto(pedido).cost;
  return budgets.spendWithBudget(ctx, { agentCode, criticality, routingPath, estimate: estimate ?? custo, at }, async () => {
    if (falhar) throw new Error('falha do provider');
    return sandboxCusto(pedido);
  }, tx);
}

const lerOrcamento = async (id, tx) => (await q('SELECT * FROM ai.budgets WHERE id = :id', { id }, tx))[0];
const alertasDe = (budgetId, tx) => q('SELECT threshold FROM ai.budget_alerts WHERE budget_id = :id ORDER BY threshold', { id: budgetId }, tx).then((r) => r.map((x) => x.threshold));
const eventosLimiar = (budgetId, tx) => q("SELECT * FROM integration.outbox_events WHERE event_type = 'ai.budget.threshold_reached' AND aggregate_id = :id ORDER BY occurred_at", { id: budgetId }, tx);

/** Parâmetro da empresa dentro da transação do teste (valida contra o SETTINGS_SCHEMA como a tela). */
// Parâmetro sensível (requiresMfa, ex.: ia.fallback.max_saltos): gravado por um operador com MFA recente real; os demais pelo caminho interno, como antes.
const definirParametro = (tenant, chave, valor, tx) => (SETTINGS_SCHEMA[chave] && SETTINGS_SCHEMA[chave].requiresMfa
  ? gravarParametroSensivel(chave, valor, tenant, tx)
  : upsertSetting(chave, valor, { groupId: tenant.groupId, companyId: tenant.companyId }, null, tx));

/** Transação REAL (commit) com o contexto do tenant, para simular conexões concorrentes. */
function comoTenant(tenant, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    return fn(transaction);
  });
}

async function rejeita(promessa, status, code) {
  const err = await promessa.then(() => null, (e) => e);
  if (!err) throw new Error(`deveria recusar com ${code}`);
  if (err.code !== code || err.statusCode !== status) throw new Error(`esperava ${status} ${code}, veio ${err.statusCode} ${err.code}: ${err.message}`);
  return err;
}

module.exports = {
  AGORA, MES_QUE_VEM, agente, sandboxCusto, criarOrcamento, gastar, lerOrcamento, alertasDe, eventosLimiar, definirParametro, comoTenant, rejeita,
};
