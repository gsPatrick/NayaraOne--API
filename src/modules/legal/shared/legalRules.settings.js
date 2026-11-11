'use strict';

const { isValidZone } = require('../../../features/migration-v2/timezone/timezone.convert');
const AppError = require('../../../utils/AppError');

/**
 * Parâmetros da Locação e do Jurídico do Marco 5 que o livro deixa em aberto (regra do Patrick: o que o livro não fixa vira
 * configuração da empresa, editável pelo administrador na aba "Locação e Jurídico" de Configurações). O padrão de cada um é o
 * comportamento que valia antes (ou o do livro, quando há), para que nada mude enquanto a empresa não gravar outro valor.
 *
 *  - Fotos da entrega de chaves (livro §10 "Fotos obrigatórias quando política exigir"): quantidade mínima por tipo de contrato
 *    e para o termo de imóvel usado. 0 = a política não exige foto. Padrão: venda (casa nova) e imóvel usado 1; locação 0.
 *  - Fuso dos prazos jurídicos (livro §15 "due_at em timezone correto"): fuso IANA da empresa. Padrão America/Sao_Paulo.
 *  - Alertas de prazo escalonados (livro §15 "Alertas escalonados por regra"): antecedência do aviso "vence em breve" e janela de
 *    escalonamento depois do primeiro aviso de vencido, por criticidade. Padrão 48 h e 24 h (o que o código fixava).
 *  - Bases jurídicas do recebível do processo (livro §14 "somente quando juridicamente cabível"): quais bases a empresa aceita.
 *    Padrão: acordo homologado e sentença transitada em julgado ligados; as demais desligadas.
 */
const KEY_DELIVERY_PHOTO_TYPES = [
  'SALE', 'SALE_CASH', 'SALE_FINANCED', 'SALE_TRADE', 'SALE_INSTALLMENTS',
  'LEASE', 'LEASE_RESIDENTIAL', 'LEASE_COMMERCIAL', 'LEASE_SEASONAL', 'PROPERTY_ADMIN',
  'SERVICE', 'CONSTRUCTION', 'USED_PROPERTY_DELIVERY',
];
const PHOTO_DEFAULTS = { SALE: 1, SALE_CASH: 1, SALE_FINANCED: 1, SALE_TRADE: 1, SALE_INSTALLMENTS: 1, USED_PROPERTY_DELIVERY: 1 };
const photoKey = (type) => `legal.chaves.fotos_minimas.${type}`;

const CRITICALITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const dueSoonKey = (crit) => `legal.prazos.alerta_antecedencia_horas.${crit}`;
const escalationKey = (crit) => `legal.prazos.escalonamento_horas.${crit}`;
const DEFAULT_DUE_SOON_HOURS = 48;
const DEFAULT_ESCALATION_HOURS = 24;
const ZONE_KEY = 'legal.prazos.fuso_horario';
const DEFAULT_ZONE = 'America/Sao_Paulo';

// Bases jurídicas reconhecidas para o recebível do processo (o rótulo vai para a descrição do lançamento).
const RECEIVABLE_BASES = {
  SETTLEMENT: 'acordo homologado',
  FINAL_JUDGMENT: 'sentença transitada em julgado',
  PROVISIONAL_ENFORCEMENT: 'cumprimento provisório de sentença',
  EXTRAJUDICIAL_TITLE: 'título executivo extrajudicial',
  COURT_DEPOSIT_RELEASE: 'alvará de levantamento de depósito judicial',
};
const RECEIVABLE_BASES_ON_BY_DEFAULT = ['SETTLEMENT', 'FINAL_JUDGMENT'];
const basisKey = (code) => `legal.processo.recebivel.base.${code}`;

function validateZone(key, value) {
  if (typeof value !== 'string' || !isValidZone(value.trim())) {
    throw AppError.badRequest(`O valor de "${key}" deve ser um fuso horário válido (por exemplo America/Sao_Paulo ou America/Manaus).`, 'SETTING_INVALID_VALUE', { key, value });
  }
}

const LEGAL_RULES_SETTINGS_SCHEMA = Object.freeze({
  ...Object.fromEntries(KEY_DELIVERY_PHOTO_TYPES.map((t) => [photoKey(t), { type: 'integer', min: 0, max: 50 }])),
  [ZONE_KEY]: { type: 'string', validate: validateZone },
  ...Object.fromEntries(CRITICALITIES.map((c) => [dueSoonKey(c), { type: 'integer', min: 1, max: 720 }])),
  ...Object.fromEntries(CRITICALITIES.map((c) => [escalationKey(c), { type: 'integer', min: 1, max: 720 }])),
  ...Object.fromEntries(Object.keys(RECEIVABLE_BASES).map((b) => [basisKey(b), { type: 'boolean' }])),
});

module.exports = {
  LEGAL_RULES_SETTINGS_SCHEMA,
  KEY_DELIVERY_PHOTO_TYPES,
  PHOTO_DEFAULTS,
  CRITICALITIES,
  RECEIVABLE_BASES,
  RECEIVABLE_BASES_ON_BY_DEFAULT,
  DEFAULT_ZONE,
  DEFAULT_DUE_SOON_HOURS,
  DEFAULT_ESCALATION_HOURS,
  keys: { photoKey, dueSoonKey, escalationKey, basisKey, ZONE_KEY },
};
