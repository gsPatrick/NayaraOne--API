'use strict';

const { CLASSES, ACTIONS, VIEW_RESTRICTED_PERMISSION } = require('./dlp.constants');

/**
 * Matriz padrão classe x ação (M9-D820 §3.2). Só o que a tabela da demanda diz que muda em relação ao "livre": cada célula lista as exigências ligadas.
 * `expiry` entra por fora (parâmetro de prazo por classe) em EXPORT e SHARE; `max_rows` por fora em EXPORT; `watermark` por fora em toda célula.
 * Células com `deny: true` nascem com allowed = false. `mask` = a IA/entrega só recebe o valor mascarado.
 */
const CELLS = Object.freeze({
  LOW: { EXPORT: ['audit'], SHARE: ['audit'] },
  MEDIUM: { EXPORT: ['audit'], PRINT: ['audit'], SHARE: ['audit'], AI: ['mask'] },
  HIGH: {
    VIEW: ['audit'], COPY: ['audit'], EXPORT: ['justification', 'mfa', 'audit'], PRINT: ['justification', 'audit'],
    SHARE: ['justification', 'mfa', 'audit'], AI: ['mask'],
  },
  RESTRICTED: {
    VIEW: ['audit', 'perm'], COPY: ['deny'], EXPORT: ['justification', 'mfa', 'audit'], PRINT: ['justification', 'mfa', 'audit'],
    SHARE: ['justification', 'mfa', 'audit'], AI: ['deny'],
  },
});

/** As 24 linhas da política inicial de uma empresa. `params` = { volume, expiry, watermark } já convertidos por classe (dlp.settings.js). */
function defaultMatrix(params) {
  const rows = [];
  for (const classification of CLASSES) {
    for (const action of ACTIONS) {
      const flags = (CELLS[classification][action]) || [];
      rows.push({
        classification,
        action,
        allowed: !flags.includes('deny'),
        requirePermission: flags.includes('perm') ? VIEW_RESTRICTED_PERMISSION : null,
        requireJustification: flags.includes('justification'),
        requireMfa: flags.includes('mfa'),
        requireAudit: flags.includes('audit'),
        requireWatermark: Boolean(params.watermark[classification]),
        requireMask: flags.includes('mask'),
        maxRows: action === 'EXPORT' ? params.volume[classification] : null,
        maxExpiryHours: action === 'EXPORT' || action === 'SHARE' ? params.expiry[classification] : null,
      });
    }
  }
  return rows;
}

module.exports = { defaultMatrix };
