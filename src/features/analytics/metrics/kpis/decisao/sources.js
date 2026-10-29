'use strict';

/**
 * M9-D709 — leitura do read model rm_decision_queue para os quatro KPIs da fila de decisão: a entrada da fórmula (itens que esperam decisão no instante da
 * leitura), o parâmetro de envelhecimento, o filtro canônico (M9-D611: os registros do read model que reproduzem o número) e o instante da fonte. Só lê o
 * schema analytics (nunca o OLTP). Posição: o cálculo vale para o dia de hoje (o provedor do snapshot diário cuida disso); um dia passado lê até o fim do dia.
 */
const { sequelize } = require('../../../../../models');
const { readAgedHours } = require('../../../read-models/decisaoFilaKpi.settings');
const { KINDS } = require('../../../read-models/decisao-fila.kinds');
const { latestSnapshotAt } = require('../snapshotAt');
const clock = require('../../clock');
const { saoPauloMidnight } = require('../../period');
const dates = require('../../period.dates');
const { MODELS } = require('./models');

const iso = (v) => (v === null || v === undefined ? null : new Date(v).toISOString());

/** Instante da leitura: agora, para a data-base de hoje; o fim do dia de São Paulo, para um dia passado. */
const instantOf = (asOfDate) => (asOfDate === clock.businessToday() ? clock.now() : saoPauloMidnight(dates.addDays(asOfDate, 1)));

async function queueItem(kind, scope, asOfDate, agedHours, snapshotAt, transaction) {
  const instant = instantOf(asOfDate);
  const [list] = await sequelize.query(
    `SELECT status, requested_at, requested_by::text AS requested_by, decided_at, amount::text AS amount, approval_type, approval_tier, warehouse_id::text AS warehouse_id,
            reason_code, item_id::text AS item_id, quantity::text AS quantity, rule_id::text AS rule_id, agent_code, proposal_type, run_id::text AS run_id, has_sources
       FROM analytics.${MODELS.queue} WHERE company_id = :companyId AND kind = :kind AND (status = 'PENDING' OR decided_at > :instant) AND (requested_at IS NULL OR requested_at <= :instant)
      ORDER BY requested_at NULLS FIRST, source_id`,
    { replacements: { companyId: scope.companyId, kind, instant }, transaction }
  );
  const rows = list.map((r) => ({ ...r, requested_at: iso(r.requested_at), decided_at: iso(r.decided_at) }));
  return {
    inputs: { asOfInstant: instant.toISOString(), rows }, params: { agedHours }, filter: { status: ['PENDING'], equals: { queueKind: kind } }, snapshotAt, readModel: MODELS.queue,
  };
}

/** { código: { inputs, params, filter, snapshotAt } } dos quatro KPIs. */
async function buildDecisionQueueItems(scope, asOfDate, transaction) {
  const agedHours = await readAgedHours(scope, transaction);
  const snapshotAt = await latestSnapshotAt(scope.companyId, [MODELS.queue], transaction);
  const out = {};
  for (const kind of Object.keys(KINDS)) out[KINDS[kind].metricCode] = await queueItem(kind, scope, asOfDate, agedHours, snapshotAt, transaction);
  return out;
}

module.exports = { buildDecisionQueueItems };
