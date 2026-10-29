'use strict';

/**
 * Política do circuit breaker (M9-D217 seção 3.2; Guia §6: "configuração vem de policy, não números espalhados"). ÚNICO lugar do
 * código com os limiares do circuito: o parâmetro da empresa (`integration.circuit.*`) vale para todas as connections e pode ser
 * sobrescrito pelo fornecedor (`providers.default_policy_json.circuit`) e pela connection (`connections.policy_json.circuit`),
 * nessa ordem de precedência. Valor fora do limite é recusado ao salvar (422 INTEGRATION_POLICY_INVALID) e, se mesmo assim aparecer
 * gravado, é descartado (volta à camada de baixo). Este arquivo é PURO (sem banco nem configurações): a leitura dos parâmetros e das
 * políticas gravadas está em circuitPolicyReader.js.
 */
const PADROES = Object.freeze({ failure_threshold: 5, cooldown_s: 120, half_open_max_calls: 3, close_after_successes: 1 });
const LIMITES = Object.freeze({
  failure_threshold: { min: 1, max: 100 },
  cooldown_s: { min: 1, max: 86400 },
  half_open_max_calls: { min: 1, max: 100 },
  close_after_successes: { min: 1, max: 100 },
});
/** Espera de quem não pôde usar uma vaga de teste do HALF_OPEN (só da empresa: não é limiar do circuito). */
const RECHECK = Object.freeze({ key: 'integration.circuit.half_open_recheck_s', padrao: 5, min: 1, max: 3600 });
const CHAVES = Object.freeze(Object.fromEntries(Object.keys(PADROES).map((k) => [k, `integration.circuit.${k}`])));
/** Classes de erro que contam como falha do fornecedor (as demais são dado nosso, limite ou credencial). */
const CLASSES_QUE_CONTAM = Object.freeze(['TRANSIENT', 'UNKNOWN']);

const valido = (campo, v) => Number.isInteger(v) && v >= LIMITES[campo].min && v <= LIMITES[campo].max;
const pick = (obj) => Object.fromEntries(Object.entries(obj && typeof obj === 'object' ? obj : {}).filter(([k, v]) => LIMITES[k] && valido(k, v)));

/** Problemas de uma seção `circuit` de política (para validatePolicyJson). */
function circuitProblems(section) {
  if (section === undefined) return [];
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return ['circuit: esperado um objeto'];
  return Object.entries(section).flatMap(([key, value]) => {
    const lim = LIMITES[key];
    if (!lim) return [`circuit.${key}: campo desconhecido`];
    return Number.isInteger(value) && value >= lim.min && value <= lim.max ? [] : [`circuit.${key}: use um inteiro de ${lim.min} a ${lim.max}`];
  });
}

/** Merge puro das camadas (empresa < fornecedor < connection), campo a campo; devolve a política efetiva. */
function mergeCircuitPolicy({ global = {}, provider, connection }) {
  return { ...PADROES, ...pick(global), ...pick(provider), ...pick(connection) };
}

/** Política padrão (sem empresa nem connection): para o circuito em memória de quem chama o fornecedor sem connection (Seguro). */
const defaultCircuitPolicy = () => ({ ...PADROES, recheck_s: RECHECK.padrao });

module.exports = { PADROES, LIMITES, RECHECK, CHAVES, CLASSES_QUE_CONTAM, circuitProblems, mergeCircuitPolicy, defaultCircuitPolicy, valido };
