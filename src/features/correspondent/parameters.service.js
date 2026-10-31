'use strict';

const { Op } = require('sequelize');
const { Rule, RuleVersion, AuditLog, User, sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const {
  peekEligibilityConfig,
  publishProviderEligibilityVersion,
  RULE_CODE: ELIGIBILITY_RULE_CODE,
  PRODUCTS,
  PRODUCT_LABEL,
} = require('./eligibility.service');
const {
  publishCommissionSplitVersion,
  RULE_CODE: COMMISSION_RULE_CODE,
  DEFAULT_ACTION: COMMISSION_DEFAULT_ACTION,
  TRIGGER_EVENT_LABEL,
  ACCOUNTING_EXPORT_SOURCE_MODES,
  DIMOB_FILE_COLUMNS,
  DIMOB_FILE_DELIMITERS,
  DIMOB_FILE_NOTICE_DEFAULT,
} = require('./commissionSplit.service');
const { evaluateRule } = require('../../engines/rules/rulesEngine');

const { knownProviders, providerLabel, CASE_STATUSES, CASE_STATUS_LABEL, PROVIDER_LABEL } = require('./correspondentCatalog');

const PROVIDERS = knownProviders();
const PURPOSES = ['RESIDENCIAL', 'COMERCIAL'];
const PURPOSE_LABEL = { RESIDENCIAL: 'Residencial', COMERCIAL: 'Comercial' };
const DOCUMENT_TYPE_LABEL = { RG_CPF: 'RG/CPF', COMPROVANTE_RENDA: 'Comprovante de renda', COMPROVANTE_RESIDENCIA: 'Comprovante de residência', MATRICULA_IMOVEL: 'Matrícula do imóvel', CERTIDAO_ESTADO_CIVIL: 'Certidão de estado civil', IPTU: 'IPTU', EXTRATO_BANCARIO: 'Extrato bancário', OUTRO: 'Outro' };
function docLabel(type) { return DOCUMENT_TYPE_LABEL[type] || String(type).replace(/_/g, ' ').toLowerCase(); }

function bad(message) {
  return AppError.badRequest(message, 'CORRESPONDENT_PARAMETERS_VALIDATION');
}

function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/** Número obrigatório: campo apagado (null/"") é erro, nunca vira o valor padrão em silêncio. Omitido (undefined) usa o padrão, se houver. */
function requiredInt(value, label, { min, max, unit = '', fallback }) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (isBlank(value)) throw bad(`Informe ${label}.`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label[0].toUpperCase()}${label.slice(1)} precisa ser um número inteiro${unit ? ` de ${unit}` : ''} entre ${min} e ${max}.`);
  return n;
}

function bool(value, label, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw bad(`${label} precisa ser sim ou não.`);
}

function percent(value, label, { min = 0, max = 100, exclusiveMin = false, decimals = 2, optional = false } = {}) {
  if (optional && isBlank(value)) return null;
  if (isBlank(value)) throw bad(`Informe ${label.charAt(0).toLowerCase()}${label.slice(1)}.`);
  const n = Number(value);
  if (!Number.isFinite(n)) throw bad(`${label} precisa ser um número.`);
  if (Math.abs(Math.round(n * 10 ** decimals) / 10 ** decimals - n) > 1e-9) {
    throw bad(`${label} aceita no máximo ${decimals} casas decimais.`);
  }
  if (n > max || n < min || (exclusiveMin && n <= min)) {
    throw bad(`${label} precisa estar ${exclusiveMin ? 'acima de' : 'entre'} ${min}% ${exclusiveMin ? 'e até' : 'e'} ${max}%.`);
  }
  return n;
}

function subset(list, allowed, label, labelOf = (v) => String(v)) {
  if (!Array.isArray(list) || list.length === 0) throw bad(`Selecione ao menos um item em ${label}.`);
  const unknown = list.filter((item) => !allowed.includes(item));
  if (unknown.length) throw bad(`${label}: valor(es) não reconhecido(s): ${unknown.map(labelOf).join(', ')}.`);
  return Array.from(new Set(list));
}

// Parâmetros de elegibilidade adicionados na auditoria exaustiva de 26/10/2026 (valem mesmo que a semente antiga não os tenha).
const ELIGIBILITY_EXTRA_DEFAULTS = {
  blockedActionCaseStatuses: ['CANCELED', 'COMPLETED', 'REJECTED'],
  requirePropertyForAppraisal: true,
  validatorMustDifferFromUploader: false,
  requireProposalOnApproval: false,
  appraisalInProgressMinutes: 10,
};

function validateEligibility(input) {
  const DOCUMENT_TYPES_ALLOWED = require('./cases/caseDocuments.service').DOCUMENT_TYPES;
  const allowedProviders = subset(input?.allowedProviders, PROVIDERS, 'Providers habilitados', providerLabel);
  const allowedPurposes = subset(input?.allowedPurposes, PURPOSES, 'Finalidades habilitadas', (v) => PURPOSE_LABEL[v] || v);
  const allowedProducts = subset(input?.allowedProducts, PRODUCTS, 'Produtos habilitados', (v) => PRODUCT_LABEL[v] || v);
  const maxAmountByProvider = {};
  for (const provider of PROVIDERS) {
    const raw = (input?.maxAmountByProvider || {})[provider];
    if (isBlank(raw)) {
      maxAmountByProvider[provider] = null;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0 || n > 999999999999.99) throw bad(`O teto de valor do provider "${providerLabel(provider)}" precisa ser um número positivo de até R$ 999.999.999.999,99 (ou vazio, para sem teto).`);
      if (Math.abs(Math.round(n * 100) / 100 - n) > 1e-9) throw bad(`O teto de valor do provider "${providerLabel(provider)}" aceita no máximo 2 casas decimais.`);
      maxAmountByProvider[provider] = n;
    }
  }
  const blockSubmissionOnPendingDuplicate = bool(input?.blockSubmissionOnPendingDuplicate, 'Bloquear envio com possível duplicata pendente', false);
  const requireConsentEvidence = bool(input?.requireConsentEvidence, 'Exigir como o cliente autorizou', false);
  const statusPollingEnabled = bool(input?.statusPollingEnabled, 'Consulta periódica de status', false);
  const blockWhenPropertyRegionUnknown = bool(input?.blockWhenPropertyRegionUnknown, 'Bloquear quando a região do imóvel é desconhecida', false);
  const duplicateWindowHours = requiredInt(input?.duplicateWindowHours, 'a janela de possível duplicata (horas)', { min: 1, max: 720, unit: 'horas', fallback: 24 });
  const stalledCaseDays = requiredInt(input?.stalledCaseDays, 'os dias sem atividade para sinalizar caso parado', { min: 1, max: 365, unit: 'dias', fallback: 7 });
  const unknownReleaseMinutes = requiredInt(input?.unknownReleaseMinutes, 'o tempo de espera antes de liberar novo envio (minutos)', { min: 0, max: 1440, unit: 'minutos', fallback: 2 });
  const validityInput = input?.documentValidityDays && typeof input.documentValidityDays === 'object' ? input.documentValidityDays : {};
  const documentValidityDays = {};
  for (const [type, value] of Object.entries(validityInput)) {
    if (isBlank(value)) continue;
    if (!DOCUMENT_TYPES_ALLOWED.includes(type)) throw bad(`Tipo de documento não reconhecido na validade: ${docLabel(type)}.`);
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw bad(`A validade do documento "${docLabel(type)}" precisa ser um número inteiro de dias entre 1 e 3650 (ou vazio, para não vencer).`);
    documentValidityDays[type] = days;
  }
  const requiredRaw = Array.isArray(input?.requiredDocumentTypes) ? input.requiredDocumentTypes : [];
  const unknownDocs = requiredRaw.filter((d) => !DOCUMENT_TYPES_ALLOWED.includes(d));
  if (unknownDocs.length) throw bad(`Tipos de documento não reconhecidos no checklist mínimo: ${unknownDocs.map(docLabel).join(', ')}.`);
  const requiredDocumentTypes = Array.from(new Set(requiredRaw));
  // Regiões (UFs) atendidas por provider: vazio = sem restrição de região para aquele provider.
  const allowedStatesByProvider = {};
  for (const provider of PROVIDERS) {
    const raw = (input?.allowedStatesByProvider || {})[provider];
    const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/);
    const ufs = Array.from(new Set(list.map((uf) => String(uf).trim().toUpperCase()).filter(Boolean)));
    const invalid = ufs.filter((uf) => !/^[A-Z]{2}$/.test(uf));
    if (invalid.length) throw bad(`As regiões do provider "${providerLabel(provider)}" precisam ser siglas de UF com 2 letras (ex.: SP, RJ). Valor inválido: ${invalid.join(', ')}.`);
    if (ufs.length) allowedStatesByProvider[provider] = ufs;
  }
  const blockedActionRaw = input?.blockedActionCaseStatuses === undefined ? ELIGIBILITY_EXTRA_DEFAULTS.blockedActionCaseStatuses : input.blockedActionCaseStatuses;
  if (!Array.isArray(blockedActionRaw)) throw bad('As etapas do caso que não aceitam novos documentos, simulações e avaliações precisam ser uma lista.');
  const unknownBlockedAction = blockedActionRaw.filter((st) => !CASE_STATUSES.includes(st));
  if (unknownBlockedAction.length) throw bad(`Etapas do caso não reconhecidas em "ações bloqueadas": ${unknownBlockedAction.map((st) => CASE_STATUS_LABEL[st] || st).join(', ')}.`);
  const blockedActionCaseStatuses = Array.from(new Set([...blockedActionRaw, 'CANCELED']));
  const requirePropertyForAppraisal = bool(input?.requirePropertyForAppraisal, 'Exigir imóvel vinculado para pedir avaliação', ELIGIBILITY_EXTRA_DEFAULTS.requirePropertyForAppraisal);
  const validatorMustDifferFromUploader = bool(input?.validatorMustDifferFromUploader, 'Quem valida o documento precisa ser outra pessoa', ELIGIBILITY_EXTRA_DEFAULTS.validatorMustDifferFromUploader);
  const requireProposalOnApproval = bool(input?.requireProposalOnApproval, 'Exigir a proposta ao registrar aprovação', ELIGIBILITY_EXTRA_DEFAULTS.requireProposalOnApproval);
  const appraisalInProgressMinutes = requiredInt(input?.appraisalInProgressMinutes, 'os minutos de espera de uma avaliação em andamento', { min: 1, max: 1440, unit: 'minutos', fallback: ELIGIBILITY_EXTRA_DEFAULTS.appraisalInProgressMinutes });
  return { allowedProviders, allowedPurposes, allowedProducts, maxAmountByProvider, blockedActionCaseStatuses, requirePropertyForAppraisal, validatorMustDifferFromUploader, requireProposalOnApproval, appraisalInProgressMinutes, blockSubmissionOnPendingDuplicate, requireConsentEvidence, statusPollingEnabled, blockWhenPropertyRegionUnknown, duplicateWindowHours, stalledCaseDays, requiredDocumentTypes, unknownReleaseMinutes, documentValidityDays, allowedStatesByProvider };
}

function validateCommission(input) {
  // Percentual por provider é opcional: vazio = vale o percentual padrão (a regra de cálculo já cai nele).
  const percentageByProvider = {};
  for (const provider of PROVIDERS) {
    const v = percent((input?.percentageByProvider || {})[provider], `O percentual de comissão do provider "${providerLabel(provider)}"`, { exclusiveMin: true, optional: true });
    if (v !== null) percentageByProvider[provider] = v;
  }
  const defaultPercentage = percent(input?.defaultPercentage, 'O percentual de comissão padrão', { exclusiveMin: true });
  const brokerSharePctByProvider = {};
  for (const provider of PROVIDERS) {
    const v = percent((input?.brokerSharePctByProvider || {})[provider], `A parte do corretor do provider "${providerLabel(provider)}"`, { optional: true });
    if (v !== null) brokerSharePctByProvider[provider] = v;
  }
  const defaultBrokerSharePct = percent(input?.defaultBrokerSharePct, 'A parte do corretor padrão');
  const allowedTriggerEvents = subset(input?.allowedTriggerEvents, Object.keys(TRIGGER_EVENT_LABEL), 'Fatos geradores aceitos', (v) => TRIGGER_EVENT_LABEL[v] || v);
  const defaultTriggerEvent = input?.defaultTriggerEvent;
  if (!allowedTriggerEvents.includes(defaultTriggerEvent)) throw bad('O fato gerador padrão precisa estar entre os fatos geradores aceitos.');
  const invoiceGraceDays = requiredInt(input?.invoiceGraceDays, 'o prazo para emitir a NFS-e da comissão (dias)', { min: 0, max: 365, unit: 'dias' });
  const dimobIncludeCommissions = bool(input?.dimobIncludeCommissions, 'Incluir comissões na DIMOB', false);
  const blockDuplicateCommissionPerTrigger = bool(input?.blockDuplicateCommissionPerTrigger, 'Bloquear comissão repetida por fato gerador', true);
  const confirmRequiresFinancePermission = bool(input?.confirmRequiresFinancePermission, 'Confirmação exige permissão financeira', true);
  const chargebackAllowedWithInvoiceInFlight = bool(input?.chargebackAllowedWithInvoiceInFlight, 'Permitir estorno com NFS-e em andamento', false);
  const receivableDueDays = requiredInt(input?.receivableDueDays, 'o prazo de recebimento da comissão (dias)', { min: 0, max: 365, unit: 'dias', fallback: 30 });
  const baseAmountTolerancePct = percent(input?.baseAmountTolerancePct ?? 10, 'A tolerância da base da comissão', { max: 1000 });
  const maxBaseRaw = input?.maxBaseAmount ?? 1000000000;
  if (isBlank(maxBaseRaw)) throw bad('Informe o teto do valor-base da comissão.');
  const maxBaseAmount = Number(maxBaseRaw);
  if (!Number.isFinite(maxBaseAmount) || maxBaseAmount <= 0 || maxBaseAmount > 999999999999.99) throw bad('O teto do valor-base da comissão precisa ser um número positivo de até R$ 999.999.999.999,99.');
  const nfseCancelMaxDays = requiredInt(input?.nfseCancelMaxDays, 'o prazo para cancelar a NFS-e (dias)', { min: 0, max: 3650, unit: 'dias', fallback: 0 });
  const dimobDueMonth = requiredInt(input?.dimobDueMonth, 'o mês do prazo da DIMOB', { min: 1, max: 12, fallback: 2 });
  const dimobLayoutLabelRaw = input?.dimobLayoutLabel === undefined ? COMMISSION_DEFAULT_ACTION.dimobLayoutLabel : String(input.dimobLayoutLabel ?? '').trim();
  if (!dimobLayoutLabelRaw) throw bad('Informe o nome da versão do layout do arquivo da DIMOB (ex.: DIMOB-{ano}-v1).');
  if (dimobLayoutLabelRaw.replace(/\{ano\}/gi, '2026').length > 16) throw bad('O nome da versão do layout da DIMOB aceita no máximo 16 caracteres (contando o ano no lugar de {ano}).');
  if (/[;\r\n]/.test(dimobLayoutLabelRaw)) throw bad('O nome da versão do layout da DIMOB não pode ter ponto e vírgula nem quebra de linha.');
  const dimobLayoutLabel = dimobLayoutLabelRaw;
  const dimobFileColumns = input?.dimobFileColumns === undefined ? COMMISSION_DEFAULT_ACTION.dimobFileColumns : input.dimobFileColumns;
  if (!Array.isArray(dimobFileColumns) || dimobFileColumns.length === 0) throw bad('Escolha ao menos uma coluna para o arquivo da DIMOB.');
  const unknownColumns = dimobFileColumns.filter((c) => !DIMOB_FILE_COLUMNS.includes(c));
  if (unknownColumns.length) throw bad(`Colunas do arquivo da DIMOB não reconhecidas: ${unknownColumns.join(', ')}.`);
  if (new Set(dimobFileColumns).size !== dimobFileColumns.length) throw bad('O arquivo da DIMOB não pode repetir a mesma coluna.');
  const dimobFileDelimiter = input?.dimobFileDelimiter === undefined ? COMMISSION_DEFAULT_ACTION.dimobFileDelimiter : input.dimobFileDelimiter;
  if (!DIMOB_FILE_DELIMITERS.includes(dimobFileDelimiter)) throw bad('O separador do arquivo da DIMOB precisa ser ponto e vírgula, vírgula ou barra vertical.');
  const dimobFileNoticeRaw = input?.dimobFileNotice === undefined ? DIMOB_FILE_NOTICE_DEFAULT : String(input.dimobFileNotice ?? '').trim();
  if (dimobFileNoticeRaw.length > 200) throw bad('O aviso do cabeçalho do arquivo da DIMOB aceita no máximo 200 caracteres.');
  if (/[\r\n]/.test(dimobFileNoticeRaw)) throw bad('O aviso do cabeçalho do arquivo da DIMOB não pode ter quebra de linha.');
  const dimobFileNotice = dimobFileNoticeRaw;
  const serviceCodeRaw = input?.nfseServiceCode === undefined || input?.nfseServiceCode === null ? '' : String(input.nfseServiceCode).trim();
  if (serviceCodeRaw.length > 20) throw bad('O código do serviço da NFS-e aceita no máximo 20 caracteres.');
  const nfseServiceCode = serviceCodeRaw;
  const nfseIssRatePct = percent(input?.nfseIssRatePct ?? 0, 'A alíquota de ISS');
  const reconciliationToleranceReais = percent(input?.reconciliationToleranceReais ?? 0, 'A tolerância das conferências fiscais', { max: 1000 });
  const accountingExportSourceMode = input?.accountingExportSourceMode === undefined ? 'BOTH' : input.accountingExportSourceMode;
  if (!ACCOUNTING_EXPORT_SOURCE_MODES.includes(accountingExportSourceMode)) throw bad('A origem da exportação contábil precisa ser: as duas, só comissão, só NFS-e ou NFS-e preferida.');
  const fiscalSensitiveRequiresFinance = bool(input?.fiscalSensitiveRequiresFinance, 'Ações fiscais sensíveis exigem também a permissão financeira', false);
  const bankRaw = input?.defaultReceiptBankAccountId;
  if (!isBlank(bankRaw) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(bankRaw))) throw bad('A conta bancária padrão de recebimento da comissão é inválida.');
  const defaultReceiptBankAccountId = isBlank(bankRaw) ? null : String(bankRaw).toLowerCase();
  const chartRaw = input?.defaultChartOfAccountId;
  if (!isBlank(chartRaw) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(chartRaw))) throw bad('A conta do plano de contas padrão da comissão é inválida.');
  const defaultChartOfAccountId = isBlank(chartRaw) ? null : String(chartRaw).toLowerCase();

  let keywordsRaw;
  if (Array.isArray(input?.dimobExcludedKeywords)) keywordsRaw = input.dimobExcludedKeywords;
  else if (isBlank(input?.dimobExcludedKeywords)) keywordsRaw = [];
  else keywordsRaw = String(input.dimobExcludedKeywords).split(/[,;]+/);
  const dimobExcludedKeywords = Array.from(new Set(keywordsRaw.map((k) => String(k).trim()).filter(Boolean)));
  if (dimobExcludedKeywords.length > 50) throw bad(`A lista de palavras que excluem lançamento da DIMOB aceita no máximo 50 itens (recebeu ${dimobExcludedKeywords.length}).`);
  const tooLong = dimobExcludedKeywords.filter((k) => k.length > 60);
  if (tooLong.length) throw bad('Cada palavra da lista de exclusão da DIMOB aceita no máximo 60 caracteres.');

  const blockedRaw = input?.blockedCaseStatuses === undefined ? ['CANCELED', 'REJECTED'] : input.blockedCaseStatuses;
  if (!Array.isArray(blockedRaw)) throw bad('As etapas do caso em que a comissão fica bloqueada precisam ser uma lista.');
  const unknownStatuses = blockedRaw.filter((st) => !CASE_STATUSES.includes(st));
  if (unknownStatuses.length) throw bad(`Etapas do caso não reconhecidas em "comissão bloqueada": ${unknownStatuses.map((st) => CASE_STATUS_LABEL[st] || st).join(', ')}.`);
  // Caso cancelado ou recusado nunca gera comissão, independentemente da configuração.
  const blockedCaseStatuses = Array.from(new Set([...blockedRaw, 'CANCELED', 'REJECTED']));

  const byTriggerRaw = input?.caseStatusesByTriggerEvent === undefined ? COMMISSION_DEFAULT_ACTION.caseStatusesByTriggerEvent : input.caseStatusesByTriggerEvent;
  if (!byTriggerRaw || typeof byTriggerRaw !== 'object' || Array.isArray(byTriggerRaw)) throw bad('As etapas do caso por fato gerador precisam ser informadas por fato gerador.');
  const caseStatusesByTriggerEvent = {};
  for (const trigger of allowedTriggerEvents) {
    const list = byTriggerRaw[trigger] === undefined || byTriggerRaw[trigger] === null ? [] : byTriggerRaw[trigger];
    if (!Array.isArray(list)) throw bad(`As etapas do caso para o fato gerador "${TRIGGER_EVENT_LABEL[trigger] || trigger}" precisam ser uma lista.`);
    const unknown = list.filter((st) => !CASE_STATUSES.includes(st));
    if (unknown.length) throw bad(`Etapas do caso não reconhecidas para o fato gerador "${TRIGGER_EVENT_LABEL[trigger] || trigger}": ${unknown.map((st) => CASE_STATUS_LABEL[st] || st).join(', ')}.`);
    caseStatusesByTriggerEvent[trigger] = Array.from(new Set(list)).filter((st) => !blockedCaseStatuses.includes(st));
  }
  return { percentageByProvider, defaultPercentage, brokerSharePctByProvider, defaultBrokerSharePct, allowedTriggerEvents, defaultTriggerEvent, invoiceGraceDays, nfseCancelMaxDays, dimobDueMonth, dimobLayoutLabel, dimobFileColumns, dimobFileDelimiter, dimobFileNotice, nfseServiceCode, nfseIssRatePct, reconciliationToleranceReais, accountingExportSourceMode, fiscalSensitiveRequiresFinance, dimobIncludeCommissions, blockedCaseStatuses, blockDuplicateCommissionPerTrigger, confirmRequiresFinancePermission, receivableDueDays, dimobExcludedKeywords, caseStatusesByTriggerEvent, baseAmountTolerancePct, maxBaseAmount, defaultReceiptBankAccountId, defaultChartOfAccountId, chargebackAllowedWithInvoiceInFlight };
}

const PARAM_LABEL = {
  allowedProviders: 'Providers habilitados', allowedPurposes: 'Finalidades habilitadas', allowedProducts: 'Produtos habilitados',
  maxAmountByProvider: 'Teto de valor por provider', blockSubmissionOnPendingDuplicate: 'Bloquear envio com possível duplicata',
  requireConsentEvidence: 'Exigir evidência do consentimento', statusPollingEnabled: 'Consulta periódica de status',
  blockWhenPropertyRegionUnknown: 'Bloquear região desconhecida', duplicateWindowHours: 'Janela de duplicata', stalledCaseDays: 'Dias para caso parado',
  requiredDocumentTypes: 'Checklist mínimo', unknownReleaseMinutes: 'Espera antes de reenviar', documentValidityDays: 'Validade dos documentos',
  allowedStatesByProvider: 'Regiões por provider', percentageByProvider: 'Percentual por provider', defaultPercentage: 'Percentual padrão',
  brokerSharePctByProvider: 'Parte do corretor por provider', defaultBrokerSharePct: 'Parte do corretor padrão', allowedTriggerEvents: 'Fatos geradores aceitos',
  defaultTriggerEvent: 'Fato gerador padrão', invoiceGraceDays: 'Prazo da NFS-e', dimobIncludeCommissions: 'Comissões na DIMOB',
  blockedCaseStatuses: 'Etapas bloqueadas', blockDuplicateCommissionPerTrigger: 'Bloquear comissão repetida', confirmRequiresFinancePermission: 'Confirmação exige permissão financeira',
  receivableDueDays: 'Prazo de recebimento', dimobExcludedKeywords: 'Palavras excluídas da DIMOB', caseStatusesByTriggerEvent: 'Etapas por fato gerador',
  baseAmountTolerancePct: 'Tolerância da base', maxBaseAmount: 'Teto do valor-base', defaultReceiptBankAccountId: 'Conta de recebimento', defaultChartOfAccountId: 'Conta do plano de contas', chargebackAllowedWithInvoiceInFlight: 'Estorno com NFS-e em andamento', nfseCancelMaxDays: 'Prazo para cancelar NFS-e', dimobDueMonth: 'Mês do prazo da DIMOB', dimobLayoutLabel: 'Versão do layout da DIMOB', dimobFileColumns: 'Colunas do arquivo da DIMOB', dimobFileDelimiter: 'Separador do arquivo da DIMOB', dimobFileNotice: 'Aviso do arquivo da DIMOB', nfseServiceCode: 'Código do serviço da NFS-e', nfseIssRatePct: 'Alíquota de ISS', reconciliationToleranceReais: 'Tolerância das conferências fiscais', accountingExportSourceMode: 'Origem da exportação contábil', fiscalSensitiveRequiresFinance: 'Ações fiscais sensíveis exigem permissão financeira', blockedActionCaseStatuses: 'Etapas que não aceitam novas ações', requirePropertyForAppraisal: 'Imóvel obrigatório na avaliação', validatorMustDifferFromUploader: 'Validador diferente de quem enviou', requireProposalOnApproval: 'Proposta obrigatória na aprovação', appraisalInProgressMinutes: 'Espera da avaliação em andamento',
};

function changedLabels(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const out = [];
  for (const key of keys) {
    if (JSON.stringify((before || {})[key] ?? null) !== JSON.stringify((after || {})[key] ?? null)) out.push(PARAM_LABEL[key] || key);
  }
  return out;
}

async function history(code, groupId, companyId, transaction) {
  const rule = await Rule.findOne({ where: { code, groupId, companyId }, transaction });
  if (!rule) return [];
  const versions = await RuleVersion.findAll({ where: { ruleId: rule.id }, order: [['versionNumber', 'DESC']], limit: 21, transaction });
  const visible = versions.slice(0, 20);
  const audits = await AuditLog.findAll({ where: { entityId: rule.id, groupId, companyId, action: { [Op.like]: 'correspondent.parameters.%' } }, order: [['created_at', 'DESC']], limit: 100, transaction });
  const reasonByVersion = {};
  for (const audit of audits) {
    const match = /\(versão (\d+)\):\s*(.*)$/s.exec(audit.reason || '');
    if (match && !reasonByVersion[match[1]]) reasonByVersion[match[1]] = { reason: match[2].replace(/\.$/, ''), at: audit.occurredAt || audit.get('created_at') || null };
  }
  const authorIds = Array.from(new Set(visible.map((v) => v.publishedByUserId).filter(Boolean)));
  const authors = authorIds.length ? await User.findAll({ where: { id: authorIds }, attributes: ['id', 'name'], transaction }) : [];
  const authorName = Object.fromEntries(authors.map((u) => [u.id, u.name]));
  return visible.map((v, index) => {
    const previous = versions[index + 1];
    const found = reasonByVersion[String(v.versionNumber)];
    return {
      id: v.id,
      versionNumber: v.versionNumber,
      effectiveFrom: v.effectiveFrom,
      effectiveUntil: v.effectiveUntil,
      action: v.actionJson,
      reason: found ? found.reason : 'Versão inicial (padrão do sistema).',
      publishedByUserId: v.publishedByUserId || null,
      publishedByName: v.publishedByUserId ? authorName[v.publishedByUserId] || 'Usuário removido' : 'Sistema',
      changedFields: previous ? changedLabels(previous.actionJson, v.actionJson) : [],
    };
  });
}

/**
 * getParameters — devolve a configuração vigente e o histórico de versões das duas regras do
 * correspondente: elegibilidade e comissão. Leitura pura: um GET nunca escreve.
 */
async function getParameters(groupId, companyId, actorUserId, transaction) {
  const eligibilityEval = await evaluateRule(ELIGIBILITY_RULE_CODE, { eligibilityCheckActive: true }, { groupId, companyId }, { transaction });
  const eligibility = eligibilityEval.decision === 'APPLY'
    ? { ruleVersionId: eligibilityEval.ruleVersionId, action: eligibilityEval.action }
    : { ruleVersionId: null, action: { ...require('./eligibility.service').DEFAULT_ACTION } };
  const commissionEval = await evaluateRule(COMMISSION_RULE_CODE, { commissionSplitActive: true }, { groupId, companyId }, { transaction });
  const commission = commissionEval.decision === 'APPLY'
    ? { ruleVersionId: commissionEval.ruleVersionId, action: commissionEval.action }
    : { ruleVersionId: null, action: { ...COMMISSION_DEFAULT_ACTION } };
  return {
    options: {
      providers: PROVIDERS,
      providerLabels: Object.fromEntries(PROVIDERS.map((p) => [p, PROVIDER_LABEL[p] || p])),
      purposes: PURPOSES,
      purposeLabels: PURPOSE_LABEL,
      documentTypes: require('./cases/caseDocuments.service').DOCUMENT_TYPES,
      documentTypeLabels: DOCUMENT_TYPE_LABEL,
      products: PRODUCTS.map((value) => ({ value, label: PRODUCT_LABEL[value] })),
      triggerEvents: Object.keys(TRIGGER_EVENT_LABEL).map((value) => ({ value, label: TRIGGER_EVENT_LABEL[value] })),
      caseStatuses: CASE_STATUSES.map((value) => ({ value, label: CASE_STATUS_LABEL[value] })),
      // Etapas que a empresa pode bloquear (cancelado e recusado ficam sempre bloqueados, fixos).
      blockableCaseStatuses: CASE_STATUSES.filter((value) => !['CANCELED', 'REJECTED'].includes(value)).map((value) => ({ value, label: CASE_STATUS_LABEL[value] })),
    },
    eligibility: {
      ruleVersionId: eligibility.ruleVersionId,
      action: { ...ELIGIBILITY_EXTRA_DEFAULTS, allowedProducts: PRODUCTS, blockSubmissionOnPendingDuplicate: false, requireConsentEvidence: false, statusPollingEnabled: false, blockWhenPropertyRegionUnknown: false, duplicateWindowHours: 24, stalledCaseDays: 7, requiredDocumentTypes: [], unknownReleaseMinutes: 2, documentValidityDays: {}, ...eligibility.action },
      history: await history(ELIGIBILITY_RULE_CODE, groupId, companyId, transaction),
    },
    commission: {
      ruleVersionId: commission.ruleVersionId,
      action: { ...COMMISSION_DEFAULT_ACTION, ...commission.action },
      history: await history(COMMISSION_RULE_CODE, groupId, companyId, transaction),
    },
    historyLimit: 20,
  };
}

function assertReason(reason) {
  if (!reason || String(reason).trim().length < 3) throw bad('Informe o motivo da alteração (mínimo 3 caracteres).');
  if (String(reason).trim().length > 500) throw bad('O motivo da alteração aceita no máximo 500 caracteres.');
}

/** Controle de concorrência otimista: quem abriu a tela em cima da versão X não sobrescreve a versão Y publicada por outra pessoa. */
function assertExpectedVersion(expectedVersionId, currentVersionId) {
  if (expectedVersionId === undefined || expectedVersionId === null || expectedVersionId === '') return;
  if (String(expectedVersionId) !== String(currentVersionId || '')) {
    throw AppError.conflict('Outra pessoa alterou estes parâmetros depois que você abriu a tela. Recarregue a página para ver a versão atual e refaça a alteração.', 'CORRESPONDENT_PARAMETERS_STALE');
  }
}

async function lockRule(key, ruleCode, groupId, companyId, transaction) {
  // Mesma chave do publicador da regra: edições concorrentes ficam em fila.
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', {
    replacements: { lockKey: `${key}:${groupId}:${companyId}:${ruleCode}` },
    transaction,
  });
}

async function updateEligibility(input, reason, actorUserId, groupId, companyId, transaction, { expectedVersionId } = {}) {
  const validated = validateEligibility(input);
  assertReason(reason);
  await lockRule('provider_eligibility_rule', ELIGIBILITY_RULE_CODE, groupId, companyId, transaction);
  const currentEval = await evaluateRule(ELIGIBILITY_RULE_CODE, { eligibilityCheckActive: true }, { groupId, companyId }, { transaction });
  assertExpectedVersion(expectedVersionId, currentEval.decision === 'APPLY' ? currentEval.ruleVersionId : null);
  const before = await peekEligibilityConfig(groupId, companyId, transaction);
  const version = await publishProviderEligibilityVersion(groupId, companyId, validated, actorUserId, transaction);
  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.parameters.eligibility.update',
      entityType: 'Rule',
      entityId: version.ruleId,
      beforeJson: before,
      afterJson: validated,
      reason: `Parâmetros de elegibilidade alterados (versão ${version.versionNumber}): ${String(reason).trim()}`,
    },
    transaction
  );
  return { versionId: version.id, versionNumber: version.versionNumber, action: validated };
}

// Campos que a tela de Parâmetros não envia: se vierem omitidos, vale o que já está publicado (e não o padrão).
const KEEP_WHEN_OMITTED = ['nfseCancelMaxDays', 'dimobDueMonth', 'dimobLayoutLabel', 'dimobFileColumns', 'dimobFileDelimiter', 'dimobFileNotice', 'nfseServiceCode', 'nfseIssRatePct', 'reconciliationToleranceReais', 'accountingExportSourceMode', 'fiscalSensitiveRequiresFinance', 'baseAmountTolerancePct', 'maxBaseAmount', 'defaultReceiptBankAccountId', 'defaultChartOfAccountId', 'chargebackAllowedWithInvoiceInFlight', 'caseStatusesByTriggerEvent'];

async function updateCommission(input, reason, actorUserId, groupId, companyId, transaction, { expectedVersionId } = {}) {
  assertReason(reason);
  // A edição não depende da regra atual estar válida (senão uma regra com erro trancaria a correção) e
  // lê o "antes" dentro do trava de publicação.
  await lockRule('commission_split_rule', COMMISSION_RULE_CODE, groupId, companyId, transaction);
  const current = await evaluateRule(COMMISSION_RULE_CODE, { commissionSplitActive: true }, { groupId, companyId }, { transaction });
  assertExpectedVersion(expectedVersionId, current.decision === 'APPLY' ? current.ruleVersionId : null);
  const merged = { ...(input || {}) };
  if (current.decision === 'APPLY' && current.action) {
    for (const key of KEEP_WHEN_OMITTED) if (merged[key] === undefined && current.action[key] !== undefined) merged[key] = current.action[key];
  }
  const action = validateCommission(merged);
  const version = await publishCommissionSplitVersion(groupId, companyId, action, actorUserId, transaction);
  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.parameters.commission.update',
      entityType: 'Rule',
      entityId: version.ruleId,
      beforeJson: current.decision === 'APPLY' ? current.action : null,
      afterJson: action,
      reason: `Parâmetros de comissão alterados (versão ${version.versionNumber}): ${String(reason).trim()}`,
    },
    transaction
  );
  return { versionId: version.id, versionNumber: version.versionNumber, action };
}

module.exports = { getParameters, updateEligibility, updateCommission, validateEligibility, validateCommission, PROVIDERS, PURPOSES };
