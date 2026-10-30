'use strict';

/**
 * Parâmetros das rotas de execução da NAY (M9-D030), na aba IA NAY de Configurações. O padrão é o valor inicial de
 * Maturacao/demandas/parametros.csv. O livro é omisso nos três: ficam conservadores.
 * - ia.run.sincrono_max_ms: até quando POST /ai/runs espera o fim do run antes de responder 202.
 * - ia.chat.max_mensagens: quantas mensagens da conversa (do usuário e da NAY) entram como histórico do próximo run (0 = nenhuma).
 * - ia.chat.conversa_validade_horas: validade do conversationId, contada do primeiro run da conversa.
 * - ia.run.entrada_max_caracteres: tamanho máximo do pedido (`input` do run e `message` do chat); acima disso 400 AI_INPUT_INVALID.
 */
const RUN_API_SETTING_DEFAULTS = Object.freeze({
  'ia.run.sincrono_max_ms': 25000,
  'ia.chat.max_mensagens': 10,
  'ia.chat.conversa_validade_horas': 24,
  'ia.run.entrada_max_caracteres': 8000,
});

const RUN_API_SETTINGS_SCHEMA = {
  'ia.run.sincrono_max_ms': { type: 'integer', min: 1, max: 600000 },
  'ia.chat.max_mensagens': { type: 'integer', min: 0, max: 50 },
  'ia.chat.conversa_validade_horas': { type: 'integer', min: 1, max: 720 },
  'ia.run.entrada_max_caracteres': { type: 'integer', min: 1, max: 100000 },
};

module.exports = { RUN_API_SETTING_DEFAULTS, RUN_API_SETTINGS_SCHEMA };
