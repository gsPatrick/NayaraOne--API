'use strict';

/**
 * Parâmetros do grounding (M9-D025), na aba IA NAY de Configurações. O padrão é o valor inicial de
 * Maturacao/demandas/parametros.csv. Todos são lidos por grounding/groundingSettings.js a cada resposta validada.
 */
const GROUNDING_SETTING_DEFAULTS = Object.freeze({
  'ia.grounding.relevancia_minima': 0.5,
  'ia.grounding.bloquear_sem_fonte': false,
  'ia.grounding.peso_relevancia': 0.6,
  'ia.grounding.tarefas_nao_factuais': 'conversa,saudacao,formatacao,traducao',
  'ia.grounding.termos_criticos': 'prazo legal,prazo contratual,vencimento do contrato,vencimento de contrato,contrato vence,vence o contrato,multa,rescisão,obrigação',
});

const GROUNDING_SETTINGS_SCHEMA = {
  'ia.grounding.relevancia_minima': { type: 'number', min: 0, max: 1 },
  'ia.grounding.bloquear_sem_fonte': { type: 'boolean' },
  'ia.grounding.peso_relevancia': { type: 'number', min: 0, max: 1 },
  'ia.grounding.tarefas_nao_factuais': { type: 'string' },
  'ia.grounding.termos_criticos': { type: 'string' },
};

module.exports = { GROUNDING_SETTING_DEFAULTS, GROUNDING_SETTINGS_SCHEMA };
