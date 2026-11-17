'use strict';

const AppError = require('../../utils/AppError');
const { LEAD_SOURCES } = require('../marketing/tracking/tracking.catalog');
const { invalidInput } = require('../marketing/tracking/tracking.errors');

/**
 * Origem do lead obrigatória na criação da oportunidade (M9:610 "Lead source" da atribuição; M9:784 KPI "Leads por origem"; DI-BI2-4).
 * Quem chega por um canal leva o próprio canal (WhatsApp -> WHATSAPP, API de parceiro -> PARTNER, importação BCP -> FORM ou a origem do papel);
 * quem cria pela tela escolhe. A edição não mexe na origem (updateOpportunity não lê `leadSource`), então ela não some depois de gravada.
 *  - sem origem (ausente, nula ou só espaços): 422 OPPORTUNITY_LEAD_SOURCE_REQUIRED, antes de gravar qualquer coisa;
 *  - origem fora do catálogo: o mesmo erro do rastreio (400 MKT_VALIDATION, com a lista permitida), também antes de gravar.
 * Devolve o código normalizado (maiúsculas).
 */
function assertLeadSource(leadSource) {
  const blank = leadSource === undefined || leadSource === null || (typeof leadSource === 'string' && leadSource.trim() === '');
  if (blank) {
    throw AppError.unprocessable(
      'Informe a origem do lead: toda oportunidade nasce com a origem (formulário, WhatsApp, parceiro etc.).',
      'OPPORTUNITY_LEAD_SOURCE_REQUIRED',
      { field: 'leadSource', allowed: LEAD_SOURCES }
    );
  }
  const source = typeof leadSource === 'string' ? leadSource.trim().toUpperCase() : '';
  if (!LEAD_SOURCES.includes(source)) throw invalidInput('Origem do lead inválida.', { field: 'leadSource', allowed: LEAD_SOURCES });
  return source;
}

module.exports = { assertLeadSource };
