'use strict';

const { readSecretParams } = require('./secretParams');
const { isBank, domainOf } = require('./secretPolicy');
const { auditarSegredo } = require('./secretAudit');
const { reportSecretIncident } = require('./secretIncidents');

/**
 * Vencimento da credencial (M9-D202 regra 4). BANK: idade máxima (padrão 90 dias) contada da última rotação.
 * Demais famílias: `secret_expires_at` informado. No instante limite avisa "VENCIDA" mas ainda opera; passando dele
 * a connection vai a AUTH_FAILED, sempre. Antes disso, avisos em `integration.secret.expiry_alert_days`.
 */
const DIA = 24 * 3600 * 1000;
const toMs = (v) => (v instanceof Date ? v.getTime() : Number(v));
const ms = (d) => (d ? new Date(d).getTime() : null);

async function baseDaIdade(connection, store) {
  if (connection.lastSecretRotationAt) return ms(connection.lastSecretRotationAt);
  if (store && connection.secretRef) {
    try {
      const d = await store.describe(connection.secretRef);
      if (d?.createdAt) return ms(d.createdAt);
    } catch (err) { /* sem metadados no cofre: usa a criação da connection */ }
  }
  return ms(connection.createdAt);
}

async function evaluateConnectionSecret(connection, { domain, store, now = Date.now(), transaction, ctx } = {}) {
  const nowMs = toMs(now);
  const params = await readSecretParams(ctx, transaction);
  const limites = [];
  if (isBank(domain)) {
    const base = await baseDaIdade(connection, store);
    if (base) limites.push(base + params.bankMaxAgeDays * DIA);
  }
  if (connection.secretExpiresAt) limites.push(ms(connection.secretExpiresAt));
  if (!limites.length) return { state: 'OK', alert: null, alertDays: null, deadline: null, daysLeft: null };
  const deadline = Math.min(...limites);
  const resto = { deadline: new Date(deadline).toISOString(), daysLeft: (deadline - nowMs) / DIA, alertDays: null };
  if (nowMs > deadline) return { state: 'EXPIRED', alert: 'VENCIDA', ...resto };
  if (nowMs === deadline) return { state: 'EXPIRED_ALERT', alert: 'VENCIDA', ...resto };
  const limiar = params.alertDays.find((d) => resto.daysLeft <= d);
  if (limiar !== undefined) return { state: 'EXPIRING', alert: 'EXPIRANDO', ...resto, alertDays: limiar };
  return { state: 'OK', alert: null, ...resto };
}

/** Aplica a regra: vencida vira AUTH_FAILED (uma vez), audita e abre incidente. */
async function enforceSecretExpiry(connection, ctx, transaction, { store, now = Date.now() } = {}) {
  const domain = await domainOf(connection, transaction);
  const avaliacao = await evaluateConnectionSecret(connection, { domain, store, now, transaction, ctx });
  let transitioned = false;
  if (avaliacao.state === 'EXPIRED' && connection.status === 'ACTIVE') {
    const { transitionConnection } = require('../registry/connections.transition');
    await transitionConnection(connection.id, 'AUTH_FAILED', ctx, transaction, { system: true });
    transitioned = true;
    await auditarSegredo(ctx, 'integration.secret.expired', connection, { deadline: avaliacao.deadline, domain }, 'Credencial vencida: integração colocada em AUTH_FAILED.', transaction);
    await reportSecretIncident({
      code: 'INTEGRATION_SECRET_EXPIRED', connectionId: connection.id, companyId: connection.companyId, groupId: connection.groupId,
      providerCode: connection.providerCode, environment: connection.environment, deadline: avaliacao.deadline,
    }, { transaction });
  }
  return { ...avaliacao, transitioned };
}

module.exports = { evaluateConnectionSecret, enforceSecretExpiry };
