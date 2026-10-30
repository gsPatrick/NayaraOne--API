'use strict';

/**
 * M9-D422 — parâmetros das automações de cadência por contrato (aba Marketing): a cadência de locação só liga quando a empresa define (padrão: desligada), os tipos de
 * contrato que contam como locação e o endereço da pesquisa de satisfação que a mensagem do marco de 30 dias leva (a pesquisa e a nota são do CRM).
 */
const LEASE_CADENCE_ON_KEY = 'marketing.locacao.cadencia_ativa';
const LEASE_TYPES_KEY = 'marketing.locacao.tipos_contrato';
const SURVEY_LINK_KEY = 'marketing.pos_chaves.link_pesquisa';

const CADENCE_SEED_DEFAULTS = Object.freeze({ [LEASE_CADENCE_ON_KEY]: false, [LEASE_TYPES_KEY]: 'LEASE,LEASE_RESIDENTIAL,LEASE_COMMERCIAL,LEASE_SEASONAL' });
const CADENCE_SEED_SETTINGS_SCHEMA = {
  [LEASE_CADENCE_ON_KEY]: { type: 'boolean' },
  [LEASE_TYPES_KEY]: { type: 'string' },
  [SURVEY_LINK_KEY]: { type: 'string' },
};

/** "A, b" -> ['A','B']; texto vazio ou ausente volta ao padrão. */
const parseTypes = (text) => String(typeof text === 'string' && text.trim() ? text : CADENCE_SEED_DEFAULTS[LEASE_TYPES_KEY]).split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);

module.exports = { LEASE_CADENCE_ON_KEY, LEASE_TYPES_KEY, SURVEY_LINK_KEY, CADENCE_SEED_DEFAULTS, CADENCE_SEED_SETTINGS_SCHEMA, parseTypes };
