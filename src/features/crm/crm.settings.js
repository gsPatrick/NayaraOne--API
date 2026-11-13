'use strict';

const AppError = require('../../utils/AppError');

/**
 * Parâmetros do CRM que o livro do Marco 3 não fixa e que o administrador edita (aba "CRM" de /painel/configuracoes).
 * DI-M3CA-2 a DI-M3CA-6 em Maturacao/demandas/decisoes-de-implementacao.md. Sem dependência do settings.service no topo
 * (ele importa este arquivo); a leitura dos valores fica em crm.params.js.
 *
 *   crm.motivos.ganho / .perda / .desistencia      listas de motivos "CODIGO=Rótulo,CODIGO=Rótulo" (livro §3 crm.loss_reasons;
 *                                                  CRMX-013 "Lead perdido exige motivo"; desistência é motivo de LOST, §10)
 *   crm.ocorrencia.sla_horas.alta|media|baixa      SLA da ocorrência por severidade (livro §15 "Ocorrência possui ... SLA")
 *   crm.tarefa_vencida.escalar_gerencia_apos_horas tarefa vencida há mais que isto escala para a gerência (livro §11)
 *   crm.gerencia.permissao                         quem é "a gerência" que recebe os escalonamentos (§11 e §15)
 *   crm.lead_automatico.responsavel_padrao         responsável do lead que chega sem usuário (WhatsApp, parceiro) (§2 CRMX-006)
 *   crm.mensagens.finalidade_obrigatoria           mensagem SAÍDA para pessoa identificada só sai com a finalidade declarada (M3-18, livro do
 *                                                  Marco 3 CRMX-008). Padrão DESLIGADO: igual ao Marco 9 entregue (sem finalidade, o consentimento
 *                                                  é conferido como TRANSACTIONAL); ligado, sem finalidade é 422 MESSAGE_PURPOSE_REQUIRED.
 */

const DEFAULT_WON_REASONS = 'PRICE_ACCEPTED=Preço aceito,FAST_DECISION=Decisão rápida,REFERRAL=Indicação,OTHER=Outro motivo';
const DEFAULT_LOST_REASONS = 'PRICE_TOO_HIGH=Preço alto,COMPETITOR=Concorrente,FINANCING_DENIED=Financiamento negado,LOCATION=Localização,OTHER=Outro motivo';
const DEFAULT_WITHDRAWAL_REASONS = 'CLIENT_GAVE_UP=Cliente desistiu,NO_RESPONSE=Sem resposta,CHANGED_MIND=Mudou de ideia';

const KEYS = Object.freeze({
  wonReasons: 'crm.motivos.ganho',
  lostReasons: 'crm.motivos.perda',
  withdrawalReasons: 'crm.motivos.desistencia',
  slaHigh: 'crm.ocorrencia.sla_horas.alta',
  slaMedium: 'crm.ocorrencia.sla_horas.media',
  slaLow: 'crm.ocorrencia.sla_horas.baixa',
  taskManagerAfterHours: 'crm.tarefa_vencida.escalar_gerencia_apos_horas',
  managerPermission: 'crm.gerencia.permissao',
  defaultLeadOwner: 'crm.lead_automatico.responsavel_padrao',
  purposeRequired: 'crm.mensagens.finalidade_obrigatoria',
});

const CRM_SETTING_DEFAULTS = Object.freeze({
  [KEYS.wonReasons]: DEFAULT_WON_REASONS,
  [KEYS.lostReasons]: DEFAULT_LOST_REASONS,
  [KEYS.withdrawalReasons]: DEFAULT_WITHDRAWAL_REASONS,
  [KEYS.slaHigh]: 24,
  [KEYS.slaMedium]: 72,
  [KEYS.slaLow]: 168,
  [KEYS.taskManagerAfterHours]: 24,
  [KEYS.managerPermission]: 'crm:dashboard:read',
  [KEYS.defaultLeadOwner]: null,
  [KEYS.purposeRequired]: false,
});

const REASON_ITEM = /^([A-Z][A-Z0-9_]{1,39})=([^,=]{1,60})$/;
const MAX_REASONS = 30;

/** "A=Rótulo a,B=Rótulo b" -> [{ code: 'A', label: 'Rótulo a' }, ...]; formato inválido ou código repetido -> null. */
function parseReasonList(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  if (!raw) return null;
  const items = [];
  for (const part of raw.split(',')) {
    const match = REASON_ITEM.exec(part.trim());
    if (!match || !match[2].trim()) return null;
    items.push({ code: match[1], label: match[2].trim() });
  }
  if (items.length > MAX_REASONS || new Set(items.map((i) => i.code)).size !== items.length) return null;
  return items;
}

function validateReasonList(key, value) {
  if (!parseReasonList(value)) {
    throw AppError.badRequest(
      `O valor de "${key}" deve ser uma lista "CODIGO=Rótulo" separada por vírgula (até ${MAX_REASONS} motivos, código em maiúsculas com letras, números e _, sem repetir). Exemplo: PRICE_TOO_HIGH=Preço alto,COMPETITOR=Concorrente.`,
      'SETTING_INVALID_VALUE',
      { key, value }
    );
  }
}

function validatePermissionCode(key, value) {
  if (!/^[a-z][a-z0-9_]*(:[a-z0-9_]+){1,3}$/.test(String(value))) {
    throw AppError.badRequest(`O valor de "${key}" deve ser um código de permissão (exemplo: crm:dashboard:read).`, 'SETTING_INVALID_VALUE', { key, value });
  }
}

function validateUuid(key, value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value))) {
    throw AppError.badRequest(`O valor de "${key}" deve ser o identificador de um usuário.`, 'SETTING_INVALID_VALUE', { key, value });
  }
}

const slaHours = { type: 'integer', min: 1, max: 2160 };
const CRM_SETTINGS_SCHEMA = Object.freeze({
  [KEYS.wonReasons]: { type: 'string', validate: validateReasonList },
  [KEYS.lostReasons]: { type: 'string', validate: validateReasonList },
  [KEYS.withdrawalReasons]: { type: 'string', validate: validateReasonList },
  [KEYS.slaHigh]: slaHours,
  [KEYS.slaMedium]: slaHours,
  [KEYS.slaLow]: slaHours,
  [KEYS.taskManagerAfterHours]: { type: 'integer', min: 0, max: 720 },
  [KEYS.managerPermission]: { type: 'string', validate: validatePermissionCode },
  [KEYS.defaultLeadOwner]: { type: 'string', validate: validateUuid },
  [KEYS.purposeRequired]: { type: 'boolean' },
});

module.exports = {
  KEYS,
  CRM_SETTING_DEFAULTS,
  CRM_SETTINGS_SCHEMA,
  DEFAULT_WON_REASONS,
  DEFAULT_LOST_REASONS,
  DEFAULT_WITHDRAWAL_REASONS,
  parseReasonList,
};
