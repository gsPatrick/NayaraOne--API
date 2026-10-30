'use strict';

/**
 * Parâmetros da defesa contra prompt injection (M9-D021), na aba IA NAY de Configurações. O padrão é o valor inicial de
 * Maturacao/demandas/parametros.csv. Os dois limiares vêm do livro-demanda (0,7 e 0,4); o mínimo de caracteres do argumento
 * "derivado de conteúdo não confiável" evita marcar valores curtos (um número, uma sigla) que casam por acaso.
 * A lista de frases-gatilho é do administrador: `ia.injecao.frases_extra` acrescenta frases (uma por linha, "peso|frase" ou só a frase,
 * que bloqueia) e `ia.injecao.frases_desativadas` desliga grupos da lista padrão (ids separados por vírgula, security/injectionPhrases.json).
 */
const INJECTION_SETTING_DEFAULTS = Object.freeze({
  'ia.injecao.limiar_bloqueio': 0.7,
  'ia.injecao.limiar_alerta': 0.4,
  'ia.injecao.derivado_min_caracteres': 4,
  'ia.injecao.frases_extra': '',
  'ia.injecao.frases_desativadas': '',
});

const INJECTION_SETTINGS_SCHEMA = {
  'ia.injecao.limiar_bloqueio': { type: 'number', min: 0, max: 1 },
  'ia.injecao.limiar_alerta': { type: 'number', min: 0, max: 1 },
  'ia.injecao.derivado_min_caracteres': { type: 'integer', min: 1, max: 100 },
  'ia.injecao.frases_extra': { type: 'string' },
  'ia.injecao.frases_desativadas': { type: 'string' },
};

module.exports = { INJECTION_SETTING_DEFAULTS, INJECTION_SETTINGS_SCHEMA };
