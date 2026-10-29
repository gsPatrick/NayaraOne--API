'use strict';

// Apoio dos testes M9-D821 (não é teste): política padrão em memória (sem banco), pedido padrão e contexto do guard.
const { defaultMatrix } = require('../../../src/features/core-governance/dlp/policy.matrix');
const settings = require('../../../src/features/core-governance/dlp/dlp.settings');

const D = settings.DLP_SETTING_DEFAULTS;
const MATRIX = defaultMatrix({ volume: settings.parseVolume(D[settings.VOLUME_KEY]), expiry: settings.parseExpiry(D[settings.EXPIRY_KEY]), watermark: settings.parseWatermark(D[settings.WATERMARK_KEY]) });
const policyOf = (classification, action, over = {}) => ({ ...MATRIX.find((p) => p.classification === classification && p.action === action), ...over });
const NOW = new Date('2026-10-29T12:00:00.000Z');
const LONG = 'Fechamento contábil do trimestre, pedido pelo contador.';

/** Pedido de exportação válido de HIGH (justificativa e MFA presentes, volume abaixo do teto). */
const request = (over = {}) => ({
  action: 'EXPORT', kind: 'EXPORT', resourceType: 'finance.entries', purpose: 'CONTABIL', justification: LONG, estimatedRows: 6000, mfaOk: true, permissions: [], ...over,
});
/** Contexto que o serviço monta para o guard puro. */
const ctx = (classification, action, over = {}) => ({
  classification, policy: policyOf(classification, action), permissions: ['governance:dlp:export'], suspendedUntil: null, now: NOW,
  purposes: settings.parsePurposes(D[settings.PURPOSES_KEY]), justificationMin: D[settings.JUSTIFICATION_MIN_KEY], ...over,
});

module.exports = { MATRIX, policyOf, request, ctx, NOW, LONG };
