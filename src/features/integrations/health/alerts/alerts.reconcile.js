'use strict';

const { runbookPathFor } = require('../runbooks');
const store = require('./alerts.store');
const { notifyAlert } = require('./alerts.notify');
const { RESOLUTIONS } = require('./alerts.constants');

const keyOf = (type, marker) => `${type}|${marker}`;
const MIN_MS = 60000;

/**
 * Concilia as condições vigentes de uma connection com os alertas abertos (M9-D224 3.3), idempotente:
 *  - condição nova: abre o alerta e avisa;
 *  - condição que continua: avisa de novo só depois de `repeat_min` (antiflap) e atualiza os números;
 *  - alerta sem condição: resolve; se foi a condição que sumiu, avisa a recuperação uma vez; um marco de credencial que cedeu lugar a outro mais urgente é só substituído.
 * Devolve { opened, renotified, resolved }.
 */
async function reconcileConnection({ connection, ctx, conditions, params, now }, transaction) {
  const abertos = await store.findOpenForConnection(connection.id, transaction);
  const porChave = new Map(abertos.map((a) => [keyOf(a.alert_type, a.window_key), a]));
  const vigentes = new Map(conditions.map((c) => [keyOf(c.type, c.marker), c]));
  const resumo = { opened: 0, renotified: 0, resolved: 0 };

  for (const [chave, cond] of vigentes) {
    const aberto = porChave.get(chave);
    if (!aberto) {
      const novo = await store.insertOpen({ connection, condition: cond, runbookPath: runbookPathFor(connection.providerCode), now }, transaction);
      if (novo) {
        await notifyAlert(ctx, { ...novo, details: cond.details }, 'OPEN', params.notifyRoles, transaction);
        await store.markNotified(novo.id, cond, now, transaction);
        resumo.opened += 1;
      }
    } else if (!aberto.last_notified_at || now.getTime() - new Date(aberto.last_notified_at).getTime() >= params.repeatMin * MIN_MS) {
      await notifyAlert(ctx, { ...aberto, severity: cond.severity, details: cond.details }, 'REPEAT', params.notifyRoles, transaction);
      await store.markNotified(aberto.id, cond, now, transaction);
      resumo.renotified += 1;
    } else {
      await store.refresh(aberto.id, cond, now, transaction);
    }
  }

  const temMarcoDeCredencial = conditions.some((c) => c.type === 'SECRET_EXPIRING');
  for (const [chave, aberto] of porChave) {
    if (vigentes.has(chave)) continue;
    const trocado = aberto.alert_type === 'SECRET_EXPIRING' && temMarcoDeCredencial;
    await store.resolve(aberto.id, trocado ? RESOLUTIONS.SUPERSEDED : RESOLUTIONS.CLEARED, now, transaction);
    if (!trocado) {
      await notifyAlert(ctx, aberto, 'RECOVERED', params.notifyRoles, transaction);
      await store.markRecoveryNotified(aberto.id, now, transaction);
    }
    resumo.resolved += 1;
  }
  return resumo;
}

/** Resolve, sem aviso, os alertas abertos de connections que saíram de cena (pausadas, desativadas ou removidas da avaliação). */
async function resolveOrphans(ctx, avaliadas, now, transaction) {
  const abertos = await store.findOpenForCompany(ctx.companyId, transaction);
  let resolved = 0;
  for (const a of abertos) {
    if (avaliadas.has(a.connection_id)) continue;
    await store.resolve(a.id, RESOLUTIONS.CONNECTION_CHANGED, now, transaction);
    resolved += 1;
  }
  return resolved;
}

module.exports = { reconcileConnection, resolveOrphans };
