'use strict';

const AppError = require('../../../utils/AppError');
const { SecretValue } = require('./SecretValue');
const { rotationFailed, secretNotFound } = require('./secrets.errors');
const { assertValue } = require('./storeContract');

/**
 * Rotação com segurança (M9-D202 regra 3): grava a versão NOVA como candidata, testa com ela e só então promove;
 * a anterior entra em graça (webhooks em voo). Se o teste falhar, a candidata é descartada e a anterior segue.
 */
async function rotateStoredSecret(store, ref, { newValue, expiresAt = null, graceMs = 0, testConnection, now = Date.now() }) {
  assertValue(newValue);
  if (typeof testConnection !== 'function') throw AppError.internal('Rotação sem teste de conexão.', 'INTERNAL_ERROR');
  let anterior = null;
  try {
    anterior = (await store.describe(ref)).version;
  } catch (err) {
    if (err.code !== 'INTEGRATION_SECRET_NOT_FOUND') throw err;
  }
  const candidata = await store.put(ref, newValue, { candidate: true, expiresAt });
  const descartar = () => store.revoke(ref, candidata).catch(() => {});
  let ok = false;
  try {
    const r = await testConnection({ value: new SecretValue(newValue), version: candidata });
    ok = r === true || r?.ok === true;
  } catch (err) {
    ok = false;
  }
  if (!ok) { await descartar(); throw rotationFailed(); }
  let version;
  try {
    version = await store.rotate(ref, candidata, { graceMs });
  } catch (err) {
    await descartar();
    throw err;
  }
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  return { previousVersion: anterior, version, graceUntil: anterior && graceMs > 0 ? new Date(nowMs + graceMs).toISOString() : null };
}

module.exports = { rotateStoredSecret, secretNotFound };
