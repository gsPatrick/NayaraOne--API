'use strict';

/**
 * Parâmetros do roteamento de modelo (M9-D012), aba IA NAY. Padrão = Maturacao/demandas/parametros.csv. O livro não dá o limite
 * entre "simples" e "complexo" nem a confiança mínima: ficam em parâmetro com valor conservador.
 *  - ia.router.resumo_simples_max_tokens: entrada (em tokens) até onde a tarefa pequena ainda vai ao modelo pequeno;
 *  - ia.router.confianca_minima: confiança (0 a 1) abaixo da qual a saída do modelo pequeno escala para o avançado;
 *  - ia.router.escalonar_para_avancado: liga o escalonamento único do pequeno para o avançado.
 */
const ROUTER_KEYS = Object.freeze({
  smallMaxTokens: 'ia.router.resumo_simples_max_tokens',
  minConfidence: 'ia.router.confianca_minima',
  escalate: 'ia.router.escalonar_para_avancado',
});

const ROUTER_SETTING_DEFAULTS = Object.freeze({
  [ROUTER_KEYS.smallMaxTokens]: 2000,
  [ROUTER_KEYS.minConfidence]: 0.6,
  [ROUTER_KEYS.escalate]: true,
});

const ROUTER_SETTINGS_SCHEMA = {
  [ROUTER_KEYS.smallMaxTokens]: { type: 'integer', min: 1, max: 1000000 },
  [ROUTER_KEYS.minConfidence]: { type: 'number', min: 0, max: 1 },
  [ROUTER_KEYS.escalate]: { type: 'boolean' },
};

module.exports = { ROUTER_KEYS, ROUTER_SETTING_DEFAULTS, ROUTER_SETTINGS_SCHEMA };
