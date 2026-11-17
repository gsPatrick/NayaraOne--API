'use strict';

/**
 * DI-BI2-2 — severidade da completude POR VERIFICAÇÃO. A severidade por tipo (`analytics.qualidade.severidades`) e o limite por campo
 * (`max_nulos_pct.<campo>`) valem para todas as verificações que medem o mesmo campo; esta chave decide, só para a verificação dela, se a
 * falha acima de `max_nulos_bloqueio_pct` BLOQUEIA o indicador (padrão) ou só AVISA. O livro diz que o KPI "pode" ser marcado DEGRADED
 * quando o check falhar (M9:837): onde o livro não exige o campo na origem, o padrão é só avisar.
 *
 *  analytics.qualidade.completude_bloqueia.<código da verificação>   ligado = bloqueia; desligado = só avisa
 */
const KEY_PREFIX = 'analytics.qualidade.completude_bloqueia.';
const blockKey = (code) => `${KEY_PREFIX}${code}`;

// false = só avisa. Cada uma com a linha do livro que mostra que o campo não é exigido na origem.
const COMPLETENESS_BLOCK_DEFAULTS = Object.freeze({
  // M6:23 ("Não conformidade exige severidade, responsável, SLA, evidência antes/depois e aceite") e M6:138-140 (closeNonconformity) não pedem a causa.
  project_nonconf_cause_code_completeness: false,
  // Mesma origem (construction.nonconformities.cause_code), lida pelo KPI de recorrência (M9:794).
  project_occurrences_cause_code_completeness: false,
  // M5:203-212 não exige contrato na vistoria, e M5:148 prevê a vistoria final de casa nova, que não tem locação.
  rental_insp_keys_contract_id_completeness: false,
});

const COMPLETENESS_BLOCK_SCHEMA = Object.freeze(Object.fromEntries(Object.keys(COMPLETENESS_BLOCK_DEFAULTS).map((code) => [blockKey(code), { type: 'boolean' }])));
const COMPLETENESS_BLOCK_SETTING_DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(COMPLETENESS_BLOCK_DEFAULTS).map(([code, v]) => [blockKey(code), v])));

/** { código: bloqueia? } com o valor gravado (booleano) ou o padrão; valor que não é booleano cai no padrão. */
function readCompletenessBlocks(get) {
  return Object.fromEntries(Object.keys(COMPLETENESS_BLOCK_DEFAULTS).map((code) => {
    const v = get(blockKey(code));
    return [code, typeof v === 'boolean' ? v : COMPLETENESS_BLOCK_DEFAULTS[code]];
  }));
}

/** A verificação bloqueia? Código sem chave própria bloqueia (comportamento de sempre). */
const completenessBlocks = (blocks, code) => (blocks || {})[code] !== false;

module.exports = { KEY_PREFIX, blockKey, COMPLETENESS_BLOCK_DEFAULTS, COMPLETENESS_BLOCK_SCHEMA, COMPLETENESS_BLOCK_SETTING_DEFAULTS, readCompletenessBlocks, completenessBlocks };
