'use strict';

const { getSecretStore } = require('../secrets/secretStoreFactory');
const { REF_RE, webhookRefOf } = require('../secrets/secretRef');
const { domainOf, assertDriverAllowed } = require('../secrets/secretPolicy');
const { evaluateConnectionSecret } = require('../secrets/secretExpiry');

const falta = (code, message, detail) => ({ code, message, detail });

/** O cofre responde que o segredo existe (só metadados, nunca o valor). */
async function existeNoCofre(store, ref) {
  try { await store.describe(ref); return true; } catch (err) { if (err && err.code === 'INTEGRATION_SECRET_NOT_FOUND') return false; throw err; }
}

/**
 * Evidência 6 (M9-D256 3.1): segredo de produção no cofre (M9-D202) com rotação programada, e segredo do webhook configurado. "Rotação programada" = a connection tem
 * prazo de renovação (família BANK: idade máxima desde a última rotação; demais: `secret_expires_at`) e ele não venceu; a exigência é o parâmetro
 * `integration.release.require_rotation_schedule`. Devolve { secret, webhookSecret }, cada um null (confere) ou { code, message, detail }.
 */
async function secretProblems(connection, ctx, params, transaction) {
  const ref = connection.secretRef;
  if (!ref || !REF_RE.test(ref)) {
    const sem = falta('INTEGRATION_RELEASE_SECRET_MISSING', 'Falta o segredo de produção no cofre desta integração.', 'sem referência do cofre');
    return { secret: sem, webhookSecret: falta('INTEGRATION_RELEASE_WEBHOOK_SECRET_MISSING', 'Falta o segredo do webhook desta integração.', 'sem referência do cofre') };
  }
  let store;
  try { store = getSecretStore(); } catch { store = null; }
  if (!store) return { secret: falta('INTEGRATION_RELEASE_SECRET_MISSING', 'Falta o segredo de produção no cofre desta integração.', 'cofre indisponível'), webhookSecret: falta('INTEGRATION_RELEASE_WEBHOOK_SECRET_MISSING', 'Falta o segredo do webhook desta integração.', 'cofre indisponível') };
  const domain = await domainOf(connection, transaction);
  let secret = null;
  try {
    assertDriverAllowed({ domain, environment: connection.environment, driver: store.driver });
  } catch (err) {
    secret = falta('INTEGRATION_RELEASE_SECRET_DRIVER', 'O cofre desta integração não é permitido em produção.', err.message);
  }
  if (!secret && !(await existeNoCofre(store, ref))) secret = falta('INTEGRATION_RELEASE_SECRET_MISSING', 'Falta o segredo de produção no cofre desta integração.', 'segredo não encontrado no cofre');
  if (!secret && params.requireRotationSchedule) {
    const aval = await evaluateConnectionSecret(connection, { domain, store, transaction, ctx });
    if (aval.state === 'EXPIRED' || aval.state === 'EXPIRED_ALERT') secret = falta('INTEGRATION_RELEASE_SECRET_EXPIRED', 'O segredo desta integração está vencido: gire a credencial antes de liberar.', 'segredo vencido');
    else if (!aval.deadline) secret = falta('INTEGRATION_RELEASE_SECRET_ROTATION_MISSING', 'Falta a rotação programada do segredo desta integração.', 'sem prazo de rotação (informe a validade do segredo)');
  }
  const webhookSecret = (await existeNoCofre(store, webhookRefOf(ref))) ? null : falta('INTEGRATION_RELEASE_WEBHOOK_SECRET_MISSING', 'Falta o segredo do webhook desta integração.', 'segredo do webhook não encontrado no cofre');
  return { secret, webhookSecret };
}

module.exports = { secretProblems };
