'use strict';

const { sandboxGenerate } = require('./sandboxGenerate');

/**
 * Perfis do provider de testes (M9-D033): `sandbox-a` e `sandbox-b` respondem de forma diferente, porém válida, ao mesmo pedido.
 * Servem para provar em CI que trocar de provedor mantém o golden verde. Continuam determinísticos e sem rede.
 *  - sandbox-a: a resposta do sandbox padrão, com outro código de modelo;
 *  - sandbox-b: abre a resposta com uma frase sem dado e cobra 50% a mais (inteiro) com 15 ms a mais de latência.
 */
const PROFILES = Object.freeze({
  'sandbox-a': Object.freeze({ modelCode: 'sandbox-a-1', preface: '', costNum: 1, costDen: 1, extraLatencyMs: 0 }),
  'sandbox-b': Object.freeze({ modelCode: 'sandbox-b-1', preface: 'Segue a resposta. ', costNum: 3, costDen: 2, extraLatencyMs: 15 }),
});

const SANDBOX_PROFILE_CODES = Object.freeze(Object.keys(PROFILES));

function makeProfileGenerate(code) {
  const profile = PROFILES[code];
  return function profileGenerate(input) {
    const base = sandboxGenerate(input);
    return {
      ...base,
      text: base.text ? `${profile.preface}${base.text}` : base.text,
      costMicros: Math.ceil((base.costMicros * profile.costNum) / profile.costDen),
      latencyMs: base.latencyMs + profile.extraLatencyMs,
      providerCode: code,
      modelCode: profile.modelCode,
    };
  };
}

module.exports = { PROFILES, SANDBOX_PROFILE_CODES, makeProfileGenerate };
