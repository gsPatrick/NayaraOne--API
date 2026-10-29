'use strict';

/**
 * M9-D703 (3.2 e 3.4) — POST /analytics/alerts/:id/ack. Lê o estado e trava a linha OPEN (FOR UPDATE; se outra conexão a mudou enquanto esperava, relê): OPEN vira ACKNOWLEDGED com autor e instante
 * (gatilho do banco só deixa essa escrita ao próprio usuário), ACKNOWLEDGED é idempotente (200 com o estado atual, sem trocar o autor), RESOLVED é 409 pela
 * mensagem única da M9-D691 (`assertTransition`). Reconhecer NÃO resolve, NÃO muda cooldown e NÃO mexe na tarefa: a normalização automática continua.
 * Ordem das recusas: 404 (inexistente, de outra empresa ou de domínio sem permissão), 403 ANALYTICS_ALERT_NOT_OWNER, 409. Auditoria com antes e depois e IP hasheado.
 */
const { sequelize } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { acknowledgeAlertInstance } = require('../alertInstanceStore.service');
const { hashIp } = require('../security/accessLog');
const { readableDomains, assertMayAcknowledge, notFound } = require('./alert.access');
const { assertTransition } = require('./transitions');
const { emitAlertEvent, TYPES } = require('./events');
const { SELECT, whereOf, replacementsOf, findAlertItem } = require('./list.service');
const { STATUSES } = require('./alert.query');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const filterOf = (ctx, id, domains) => ({ companyId: ctx.companyId, statuses: STATUSES.slice(), domains, id });

/** Leitura sem trava (a RLS de UPDATE esconde do SELECT ... FOR UPDATE o que já não está OPEN, então o estado atual vem daqui). */
async function readInstance(ctx, id, domains, transaction) {
  const filter = filterOf(ctx, id, domains);
  const [rows] = await sequelize.query(`${SELECT}${whereOf(filter)}`, { replacements: replacementsOf(filter), transaction });
  return rows[0] || null;
}

/** Trava a linha OPEN (FOR UPDATE). Vazio = outra conexão já mudou o estado enquanto esperávamos: o chamador relê. */
async function lockOpenInstance(ctx, id, domains, transaction) {
  const filter = filterOf(ctx, id, domains);
  const [rows] = await sequelize.query(`${SELECT}${whereOf(filter)} AND i.status = 'OPEN' FOR UPDATE OF i`, { replacements: replacementsOf(filter), transaction });
  return rows[0] || null;
}

const stateOf = (row) => ({ status: row.status, acknowledgedBy: row.acknowledged_by || null, acknowledgedAt: row.acknowledged_at || null });

/** ctx = { companyId, groupId, actorUserId, permissions }; meta = { ip }. Devolve o alerta no formato da lista. */
async function acknowledgeAlert(ctx, instanceId, meta, transaction) {
  if (!UUID_RE.test(String(instanceId))) throw notFound();
  const domains = await readableDomains(ctx, transaction);
  let current = domains.length ? await readInstance(ctx, instanceId, domains, transaction) : null;
  if (!current) throw notFound();
  await assertMayAcknowledge(ctx, current, transaction);
  if (current.status === 'OPEN') {
    const locked = await lockOpenInstance(ctx, instanceId, domains, transaction);
    current = locked || await readInstance(ctx, instanceId, domains, transaction); // perdeu a corrida: relê o estado que o outro gravou
    if (!current) throw notFound();
  }
  if (current.status === 'ACKNOWLEDGED') return findAlertItem(ctx, instanceId, transaction);
  assertTransition(current.status, 'ACKNOWLEDGED');
  const updated = await acknowledgeAlertInstance(instanceId, { actorUserId: ctx.actorUserId }, transaction);
  await registrarAuditoria({
    groupId: current.group_id, companyId: current.company_id, actorUserId: ctx.actorUserId, action: 'analytics.alert.ack', entityType: 'analytics.alert_instance', entityId: instanceId,
    beforeJson: stateOf(current), afterJson: { ...stateOf(updated), ipHash: hashIp(meta && meta.ip) },
    reason: `Alerta ${current.alert_code} reconhecido`,
  }, transaction);
  emitAlertEvent(transaction, {
    type: TYPES.ACKNOWLEDGED, instanceId, alertCode: current.alert_code, metricCode: current.metric_code, severity: current.severity, companyId: current.company_id,
    groupId: current.group_id, acknowledgedBy: updated.acknowledged_by, acknowledgedAt: updated.acknowledged_at,
  });
  return findAlertItem(ctx, instanceId, transaction);
}

module.exports = { acknowledgeAlert };
