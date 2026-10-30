'use strict';

/**
 * M9-D628 (3.4) — gravação dos sinais técnicos GLOBAIS em analytics.tech_signal_log: sondas de saúde (API, banco, fila, storage) e falhas de autenticação
 * (login e MFA). Cada sinal vai numa transação PRÓPRIA e curta (com o escritor do BI ligado): um sinal nunca entra na transação do chamador, então a falha
 * de login que reverte a requisição continua registrada, e a gravação do sinal nunca derruba o fluxo (erro vai para o log). Sem e-mail, IP, nome nem
 * segredo: só o hash SHA-256 do usuário (ou do e-mail digitado) e do IP, para contar usuários distintos sem identificar ninguém (M9-D628 3.3).
 */
const crypto = require('node:crypto');
const { sequelize } = require('../../../models');
const logger = require('../../../utils/logger');
const clock = require('../metrics/clock'); // M9-D606: o relógio do BI é um só

const KINDS = Object.freeze({ PROBE: 'PROBE', LOGIN_FAILURE: 'LOGIN_FAILURE', MFA_FAILURE: 'MFA_FAILURE' });

const hashOf = (value) => (value === null || value === undefined || value === '' ? null : crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex'));

async function insertSignal(signal, transaction) {
  await sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction });
  await sequelize.query(
    `INSERT INTO analytics.tech_signal_log (kind, probe, ok, actor_hash, ip_hash, occurred_at) VALUES (:kind, :probe, :ok, :actor, :ip, :at)`,
    { replacements: { kind: signal.kind, probe: signal.probe || null, ok: signal.ok === undefined ? null : signal.ok, actor: hashOf(signal.actor), ip: hashOf(signal.ip), at: signal.occurredAt || clock.now() }, transaction }
  );
}

/** Grava um sinal { kind, probe?, ok?, actor?, ip?, occurredAt? }. Nunca lança: devolve true se gravou. */
async function recordTechSignal(signal) {
  try {
    await sequelize.transaction((transaction) => insertSignal(signal, transaction));
    return true;
  } catch (err) {
    logger.warn({ event: 'analytics.tech_signal.record_failed', kind: signal && signal.kind, err: err.message }, '[analytics] não foi possível gravar o sinal técnico');
    return false;
  }
}

const recordLoginFailure = ({ email, ip }) => recordTechSignal({ kind: KINDS.LOGIN_FAILURE, actor: email, ip });
const recordMfaFailure = ({ userId, ip }) => recordTechSignal({ kind: KINDS.MFA_FAILURE, actor: userId, ip });

/** Apaga os sinais mais antigos que `retentionDays` (o escritor do BI tem DELETE; o runtime não grava em outra tabela). Devolve quantos apagou. */
async function purgeTechSignals({ now = clock.now(), retentionDays }, transaction) {
  await sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction });
  const [, meta] = await sequelize.query("DELETE FROM analytics.tech_signal_log WHERE occurred_at < CAST(:now AS timestamptz) - make_interval(days => :days)", { replacements: { now, days: retentionDays }, transaction });
  return meta && meta.rowCount ? meta.rowCount : 0;
}

module.exports = { KINDS, hashOf, recordTechSignal, recordLoginFailure, recordMfaFailure, purgeTechSignals };
