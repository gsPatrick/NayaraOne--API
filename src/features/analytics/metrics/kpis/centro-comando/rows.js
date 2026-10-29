'use strict';

/**
 * M9-D710 — leitura do read model rm_command_events para o cálculo dos KPIs de fatos do dia. Só lê o schema analytics (nunca o OLTP). Soma no banco, por dimensão, a janela atual e a
 * imediatamente anterior (contagem = soma de count_effect, então original + compensatória dão zero; valor = soma de amount). Fatos sem data (occurred_at nulo, só a linha original)
 * viram `undated`. Pagamentos: só valor igual ou acima do limiar (pelo valor absoluto, para a compensatória acompanhar a original) e dinheiro de terceiros marcado à parte.
 */
const { sequelize } = require('../../../../../models');
const { latestSnapshotAt } = require('../legalCor/snapshotAt');
const { windowOf } = require('./windows');
const { DEFINITIONS } = require('./definitions');

const MODEL = DEFINITIONS[0].sourceReadModel; // o nome do read model vem da definição do registry (rm_command_events)

const IN_CURRENT = 'occurred_at >= :from AND occurred_at < :to';
const IN_PREVIOUS = 'occurred_at >= :previousFrom AND occurred_at < :from';
const sum = (filter) => `COALESCE(SUM(count_effect) FILTER (WHERE ${filter}), 0)::int AS count, COALESCE(SUM(amount) FILTER (WHERE ${filter}), 0)::text AS amount`;
const noValue = `COALESCE(SUM(count_effect) FILTER (WHERE ${IN_CURRENT} AND amount IS NULL), 0)::int AS "withoutValue"`;

/** Por dimensão (colunas de `group`): janela atual (count, amount) e, em previousSql, o total da janela anterior. */
const GROUPS = Object.freeze({
  CONTRACT_SIGNED: { select: 'COALESCE(contract_type, \'SEM_TIPO\') AS type', group: 'contract_type', extra: '', where: '', previousWhere: '' },
  OPPORTUNITY_WON: { select: 'broker_id::text AS broker, origin', group: 'broker_id, origin', extra: `, ${noValue}`, where: '', previousWhere: '' },
  PAYMENT_SETTLED: { select: 'account_id::text AS account, is_third_party AS "thirdParty"', group: 'account_id, is_third_party', extra: '', where: ' AND ABS(amount) >= CAST(:threshold AS numeric)', previousWhere: ' AND NOT is_third_party' },
});

async function loadKind(kind, scope, win, threshold, transaction) {
  const g = GROUPS[kind];
  const replacements = { companyId: scope.companyId, kind, from: win.from, to: win.to, previousFrom: win.previousFrom, threshold };
  const query = async (sql) => (await sequelize.query(sql, { replacements, transaction }))[0];
  const rows = await query(`SELECT ${g.select}, ${sum(IN_CURRENT)}${g.extra} FROM analytics.${MODEL} WHERE company_id = :companyId AND kind = :kind${g.where} GROUP BY ${g.group} ORDER BY ${g.group}`);
  const [previous] = await query(`SELECT ${sum(IN_PREVIOUS)} FROM analytics.${MODEL} WHERE company_id = :companyId AND kind = :kind${g.where}${g.previousWhere}`);
  const [undated] = await query(`SELECT COUNT(*)::int AS n FROM analytics.${MODEL} WHERE company_id = :companyId AND kind = :kind AND revision = 0 AND occurred_at IS NULL${g.where}`);
  return { rows, previous, undated: undated.n };
}

async function loadCommandEventRows(scope, asOfDate, settings, transaction) {
  const win = windowOf(asOfDate, settings.now, settings.hours);
  const at = await latestSnapshotAt(scope.companyId, [MODEL], transaction);
  const out = { window: win, snapshotAt: {} };
  out.contracts = await loadKind('CONTRACT_SIGNED', scope, win, settings.threshold, transaction);
  out.opportunities = await loadKind('OPPORTUNITY_WON', scope, win, settings.threshold, transaction);
  out.payments = await loadKind('PAYMENT_SETTLED', scope, win, settings.threshold, transaction);
  for (const code of ['legal.contracts_signed', 'crm.opportunities_won', 'fin.payments_settled_relevant']) out.snapshotAt[code] = at;
  return out;
}

module.exports = { loadCommandEventRows, COMMAND_READ_MODELS: [MODEL] };
