'use strict';

const { makeBankDouble } = require('./bank.double');
const { makeInsuranceDouble } = require('./insurance.double');
const { makeManualDouble, manualMeta } = require('./insurance.manual.double');

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
});

/** { legacy, meta } do duplo pedido pela fixture, ou null. Nome desconhecido é defeito da fixture (lança). */
function loadDouble(name) {
  if (!name) return null;
  const d = DOUBLES[name];
  if (!d) throw new Error(`CONTRACT_DOUBLE_UNKNOWN: duplo de contrato desconhecido (${name}).`);
  return { legacy: d.make(), meta: d.meta ? d.meta() : null };
}

/** `meta` extra do duplo pedido pela fixture (ou null). */
const doubleMeta = (name) => (name && DOUBLES[name] && DOUBLES[name].meta ? DOUBLES[name].meta() : null);

module.exports = { loadDouble, doubleMeta, DOUBLES };
