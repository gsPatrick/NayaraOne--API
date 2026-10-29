'use strict';

/**
 * M9-D632 / M9-D633 — peças comuns dos parâmetros do administrador dos KPIs de Comercial e Imóveis (aba "BI e Centro de Comando" em /painel/configuracoes):
 * o owner (papel responsável pela reconciliação) de cada indicador, `analytics.owner.<código>`, com o padrão do livro, e a leitura de inteiros com limites.
 * Cada demanda declara os seus parâmetros no próprio arquivo (imoveisKpi.settings.js, corretoresKpi.settings.js). Arquivo sem dependência de
 * settings.service no topo (evita ciclo); a leitura usa import tardio.
 */
const DEFAULT_OWNER = 'Gerência Comercial (papel comercial-gestor)';
const OWNER_KEY = (code) => `analytics.owner.${code}`;

/** Padrões e esquema (texto livre) do owner de cada código. */
const ownerDefaults = (codes) => Object.fromEntries(codes.map((code) => [OWNER_KEY(code), DEFAULT_OWNER]));
const ownerSchema = (codes) => Object.fromEntries(codes.map((code) => [OWNER_KEY(code), { type: 'string' }]));

async function readSetting(key, scope, transaction, fallback) {
  const { getSetting } = require('../../settings/settings.service');
  return getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, fallback);
}

/** Inteiro entre min e max; fora disso (ou ausente) cai no padrão. */
const whole = (value, fallback, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : fallback);

async function readCommercialOwner(metricCode, scope, transaction) {
  const value = await readSetting(OWNER_KEY(metricCode), scope, transaction, DEFAULT_OWNER);
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_OWNER;
}

module.exports = { DEFAULT_OWNER, OWNER_KEY, ownerDefaults, ownerSchema, readSetting, whole, readCommercialOwner };
