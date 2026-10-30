'use strict';

const { makeBankDouble } = require('./bank.double');
const { makeInsuranceDouble } = require('./insurance.double');
const { makeManualDouble, manualMeta } = require('./insurance.manual.double');
const { s3Context, setupLocalDisk } = require('./storage.double');
const { prepareSandbox, prepareLocal, makeSessionStoreDouble, setupLocalSecret } = require('./identity.double');

/**
 * Objetos antigos duplos dos adapters que, em produção, só montam o objeto do fornecedor com a credencial do cofre e a configuração da empresa (M9-D222 3.2: a suíte de contrato é
 * determinística e não abre rede nem banco). A fixture declara `legacyDouble: "<nome>"`; o adapter sob teste recebe o duplo como objeto antigo, e `meta` (quando existe) segue no
 * 3º argumento de cada operação. O duplo nunca é usado fora da suíte.
 */
const DOUBLES = Object.freeze({
  'bank-santander': { make: makeBankDouble },
  'insurance-porto-seguro': { make: makeInsuranceDouble },
  'insurance-yelum': { make: makeInsuranceDouble },
  'insurance-manual': { make: makeManualDouble, meta: manualMeta },
  // Ambiente de contrato (M9-D242): `context()` (config, segredo e http da connection de laboratório), `prepare(pedido)` (pedido com credencial emitida na hora) e `setup()` (devolve a função que desfaz).
  'storage-local-disk': { setup: setupLocalDisk },
  'storage-s3': { context: s3Context },
  'identity-sandbox': { prepare: prepareSandbox },
  'identity-local': { make: makeSessionStoreDouble, prepare: prepareLocal, setup: setupLocalSecret },
});

/** { legacy, meta } do duplo pedido pela fixture, ou null. Nome desconhecido é defeito da fixture (lança). */
function loadDouble(name) {
  if (!name) return null;
  const d = DOUBLES[name];
  if (!d) throw new Error(`CONTRACT_DOUBLE_UNKNOWN: duplo de contrato desconhecido (${name}).`);
  return { legacy: d.make ? d.make() : null, meta: d.meta ? d.meta() : null, context: d.context ? d.context() : null, prepare: d.prepare || null, setup: d.setup || null };
}

/** `meta` extra do duplo pedido pela fixture (ou null). */
const doubleMeta = (name) => (name && DOUBLES[name] && DOUBLES[name].meta ? DOUBLES[name].meta() : null);

/** Pedido da fixture adaptado pelo duplo (credencial emitida na hora); sem duplo ou sem `prepare`, o próprio pedido. */
const prepareRequest = (name, pedido) => (name && DOUBLES[name] && DOUBLES[name].prepare ? DOUBLES[name].prepare(pedido) : pedido);

module.exports = { loadDouble, doubleMeta, prepareRequest, DOUBLES };
