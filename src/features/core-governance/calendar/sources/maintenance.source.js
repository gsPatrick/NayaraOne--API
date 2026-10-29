'use strict';

const { dueFromDateValue } = require('./time');
const { lifecycle, ownerOf } = require('./lifecycle');

/** Fonte MAINTENANCE (ordem de manutenção agendada) — M9-D802 §3.1.1. O fim da janela é o início mais a duração padrão configurada. */
const order = lifecycle('MAINTENANCE', (p, ctx) => {
  const dueAt = dueFromDateValue(p.scheduledAt, { dateOnly: false });
  return dueAt && {
    title: p.assetName ? `Manutenção: ${p.assetName}` : 'Manutenção agendada',
    dueAt,
    endAt: new Date(dueAt.getTime() + (ctx.durationMin || 60) * 60000),
    deepLink: `/painel/obras/pos-obra/ordens/${p.id}`,
    ...ownerOf(p.responsibleUserId, 'MAINTENANCE', ctx),
  };
});

const EVENT_MAPPERS = {
  'maintenance.order.scheduled': order.upsert,
  'maintenance.order.rescheduled': order.upsert,
  'maintenance.order.completed': order.done,
  'maintenance.order.cancelled': order.cancelled,
};

module.exports = { EVENT_MAPPERS };
