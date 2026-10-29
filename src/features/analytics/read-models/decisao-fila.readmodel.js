'use strict';

/**
 * M9-D709 — read model rm_decision_queue (schema analytics): a fila única do que espera decisão humana (aprovações financeiras, ajustes de estoque,
 * aprovações de regra e propostas da NAY). Uma linha por (empresa, kind, source_id); cada evento (ou a agenda de 15 minutos) refaz o ESTADO da linha a
 * partir da fonte (nunca delta), então replay não muda nada e o rebuild reproduz o mesmo resultado. Item decidido ou cancelado fica com o status e a data
 * (o histórico do número está nos snapshots). O BI só lista; a decisão continua nos módulos de origem, com MFA e separação de funções deles.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { KINDS, KIND_CODES, EVENT_TYPES, keyOfEvent } = require('./decisao-fila.kinds');
const { loadSource, listSourceIds } = require('./decisao-fila.sources');
const { readQueueOwner } = require('./decisaoFilaKpi.settings');

const MODEL = 'rm_decision_queue';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Evento de um item que a fila não acompanha (recomendação sem ação proposta, por exemplo) é ignorado: a fonte não o tem na fila e não há linha dele.
 * Item que a fila já tem e sumiu da fonte continua passando, para sair como cancelado.
 */
async function aggregateKey(event, { transaction } = {}) {
  const key = keyOfEvent(event);
  if (!key || !transaction) return key;
  if (await loadSource(key.kind, event.companyId, key.source_id, transaction)) return key;
  const [known] = await sequelize.query(
    `SELECT 1 FROM analytics.${MODEL} WHERE company_id = :companyId AND kind = :kind AND source_id = :sourceId`,
    { replacements: { companyId: event.companyId, kind: key.kind, sourceId: key.source_id }, transaction }
  );
  return known.length ? key : null;
}

async function recompute({ companyId, groupId, key, event, now, transaction }) {
  const fields = await loadSource(key.kind, companyId, key.source_id, transaction, now);
  const owner = await readQueueOwner(KINDS[key.kind].metricCode, { companyId, groupId }, transaction);
  const sourceEventId = event && UUID.test(String(event.id)) ? String(event.id) : null;
  if (!fields) { // a fonte não existe mais (apagada): o item sai da fila como cancelado
    return {
      fields: {
        source_type: KINDS[key.kind].sourceType, title: 'Item removido da origem', owner_role: owner, status: 'CANCELED', decided_at: now, amount: null, source_event_id: sourceEventId,
      },
      sourceSnapshotAt: now,
    };
  }
  return { fields: { ...fields, source_type: KINDS[key.kind].sourceType, owner_role: owner, source_event_id: sourceEventId }, sourceSnapshotAt: now };
}

/** Todos os itens da fonte da empresa (rebuild): cada um refeito do zero. */
async function allKeys({ companyId, transaction }) {
  const out = [];
  for (const kind of KIND_CODES) for (const id of await listSourceIds(kind, companyId, transaction)) out.push({ kind, source_id: id });
  return out;
}

/** Agenda (15 min): os pendentes da fonte (pega o que um evento ausente ou com outro nome deixou de avisar) e os que a fila ainda tem como pendentes (fecha os decididos). */
async function scheduledKeys({ companyId, limit, transaction }) {
  const out = new Map();
  for (const kind of KIND_CODES) for (const id of await listSourceIds(kind, companyId, transaction, { pendingOnly: true, limit })) out.set(`${kind}|${id}`, { kind, source_id: id });
  const [queued] = await sequelize.query(`SELECT kind, source_id FROM analytics.${MODEL} WHERE company_id = :companyId AND status = 'PENDING' LIMIT :limit`, { replacements: { companyId, limit }, transaction });
  for (const r of queued) out.set(`${r.kind}|${r.source_id}`, { kind: r.kind, source_id: r.source_id });
  return [...out.values()].slice(0, limit);
}

const def = registerReadModel({
  name: MODEL, version: 1, keyColumns: ['kind', 'source_id'], eventTypes: [...EVENT_TYPES], aggregateKey, recompute,
  scheduled: { keys: scheduledKeys }, rebuild: { keys: allKeys },
});

module.exports = { def, recompute, MODEL };
