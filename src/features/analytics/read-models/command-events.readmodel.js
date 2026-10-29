'use strict';

/**
 * Marco 9, demanda M9-D710 (Centro de Comando, bloco 1 "o que aconteceu"): read model rm_command_events (schema analytics), um registro por FATO do dia (contrato assinado, oportunidade ganha,
 * pagamento liquidado), com revisão: a original (revision 0) e, se o fato foi revertido na origem, a compensatória (revision 1, valor negado, mesmo instante). O agregado é (kind, source_id):
 * o worker (M9-D607) regrava as duas linhas do registro a partir do ESTADO da fonte, idempotente por sourceEventId; o rebuild (M9-D608) enumera todos os registros-fonte. A agenda reconfere
 * os registros mexidos na janela (janela + 1 dia), o que também faz os KPIs recalcularem a janela móvel sem evento novo. Só ids e agregados: nome, documento e descrição nunca entram.
 * Uma fonte por arquivo em command-events/ (contracts, opportunities, payments).
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { businessDateKey } = require('../../../utils/businessDate');
const clock = require('../metrics/clock');
const { readWindowHours } = require('./commandEvents.settings');
const { COLUMNS } = require('./command-events/sql');
const SOURCES = Object.freeze([require('./command-events/contracts'), require('./command-events/opportunities'), require('./command-events/payments')]);

const NAME = 'rm_command_events';
const bySource = new Map(SOURCES.map((s) => [s.kind, s]));
const byEvent = new Map(SOURCES.flatMap((s) => s.eventTypes.map((type) => [type, s])));
const HOUR = 3600 * 1000;

const rows = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];

/** Todos os eventos de um tipo vão para o mesmo registro de fonte; um tipo compartilhado entre fontes não existe. */
function aggregateKey(event) {
  const source = byEvent.get(event.eventType);
  const id = source && source.idOf(event);
  return id ? { kind: source.kind, source_id: String(id) } : null;
}

async function recompute({ companyId, key, now, event, transaction }) {
  const source = bySource.get(key.kind);
  const found = await rows(source.slice(), { companyId, sourceId: key.source_id, ...source.replacements() }, transaction);
  return {
    rows: found.map((r) => ({ key: { revision: r.revision }, fields: Object.fromEntries(COLUMNS.map((c) => [c, r[c]])) })),
    sourceSnapshotAt: (event && event.occurredAt) || now,
  };
}

const keysOf = (source, { companyId, since, full, transaction }) => rows(source.keysSql({ full }), { companyId, since, ...source.replacements() }, transaction)
  .then((list) => list.map((r) => ({ kind: source.kind, source_id: r.source_id })));

async function scheduledKeys({ companyId, groupId, now, transaction }) {
  const hours = await readWindowHours({ companyId, groupId }, transaction);
  const since = new Date(now.getTime() - (hours + 24) * HOUR);
  return (await Promise.all(SOURCES.map((s) => keysOf(s, { companyId, since, full: false, transaction })))).flat();
}

async function rebuildKeys({ companyId, transaction }) {
  return (await Promise.all(SOURCES.map((s) => keysOf(s, { companyId, since: businessDateKey(clock.now()), full: true, transaction })))).flat();
}

module.exports = registerReadModel({
  name: NAME, version: 1, keyColumns: ['kind', 'source_id', 'revision'], aggregateColumns: ['kind', 'source_id'], eventTypes: [...byEvent.keys()],
  aggregateKey, recompute, scheduled: { keys: scheduledKeys }, rebuild: { keys: rebuildKeys },
});
