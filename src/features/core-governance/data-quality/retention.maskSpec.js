'use strict';

/**
 * Interface `maskSpecFor(schema, table, column)` (M9-D910 §3.2.7, consumida pela anonimização da retenção M9-D911 §3.3.4): devolve { masking, maskPattern } do campo no registro de
 * classificação. A M9-D910 chama `setProvider` com a leitura do registro; antes disso (e para coluna sem linha) vale a regra mais protetora: FULL.
 * A anonimização só aceita HASH e FULL (valor irreversível); qualquer outra máscara do registro (NONE, PARTIAL, TOKENIZE) é tratada como FULL, porque mascarar
 * "em parte" ou tokenizar (reversível) não anonimiza.
 */
const IRREVERSIBLE = Object.freeze(['HASH', 'FULL']);
const FALLBACK = Object.freeze({ masking: 'FULL', maskPattern: null });
let provider = async () => FALLBACK;

const setProvider = (fn) => { provider = fn; };
const resetProvider = () => { provider = async () => FALLBACK; };
const maskSpecFor = (schema, table, column, ctx) => provider(schema, table, column, ctx);

/** A máscara irreversível a aplicar na anonimização: HASH ou FULL. */
async function irreversibleMasking(schema, table, column, ctx) {
  const spec = (await maskSpecFor(schema, table, column, ctx)) || FALLBACK;
  return IRREVERSIBLE.includes(spec.masking) ? spec.masking : 'FULL';
}

module.exports = { maskSpecFor, irreversibleMasking, setProvider, resetProvider, IRREVERSIBLE };
