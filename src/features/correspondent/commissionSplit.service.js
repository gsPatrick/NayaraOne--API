'use strict';

const crypto = require('crypto');
const { Rule, RuleVersion, RuleScope, RulePublication, sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { evaluateRule } = require('../../engines/rules/rulesEngine');
const { providerLabel } = require('./correspondentCatalog');

/**
 * COR_COMMISSION_SPLIT — Marco 8 Fase 8 (Caderno: "Split corretor/gerente vem do Motor de
 * Regras.", "Comissão guarda fato gerador, provider, base e rule_version_id."). MESMO padrão
 * arquitetural já usado por COR_PROVIDER_ELIGIBILITY (Fase 4) e REG-EST-002: a regra guarda
 * CONFIGURAÇÃO (percentual de comissão por provider) no `actionJson`; o cálculo concreto é
 * aplicado em código usando essa config — nunca hard-coded, nunca embutido no AST da regra.
 */
const RULE_CODE = 'COR_COMMISSION_SPLIT';
const RULE_NAME = 'Percentual de comissão (NC) por provider de financiamento';
const RULE_DOMAIN = 'correspondent';
const CONDITION_AST = { fact: 'commissionSplitActive', op: '==', value: true };

// Semente inicial — nenhum documento fonte define percentuais exatos ("split vem do Motor de
// Regras" sem definir o número); usado só como valor padrão no primeiro uso do tenant. Depois de
// publicada, quem decide é a RuleVersion (editável via publishCommissionSplitVersion).
// Arquivo do DIMOB: o layout oficial da Receita é decisão da empresa/contador. Versão do layout, colunas (e a ordem),
// separador e aviso do cabeçalho são parâmetros, para trocar o formato sem mexer no código.
const DIMOB_FILE_COLUMNS = ['tipo', 'contrato', 'locador_documento', 'locador_nome', 'locatario_documento', 'locatario_nome', 'imovel', 'valor_no_ano', 'situacao', 'pendencias'];
const DIMOB_FILE_DELIMITERS = [';', ',', '|'];
const DIMOB_FILE_NOTICE_DEFAULT = 'formato interno de conferência, não é o arquivo oficial da Receita';

const DEFAULT_ACTION = {
  percentageByProvider: { sandbox: 1.5, manual: 1 },
  defaultPercentage: 1,
  // Split corretor/gerente: o caderno manda vir do Motor de Regras, mas não define os números;
  // a semente não divide nada (100% corretor) e a empresa configura em "Parâmetros do correspondente".
  brokerSharePctByProvider: {},
  defaultBrokerSharePct: 100,
  // Fato gerador da comissão (o caderno exige guardá-lo): lista configurável e o padrão.
  allowedTriggerEvents: ['CONTRATO_ASSINADO', 'RECURSO_LIBERADO', 'REGISTRO_MANUAL'],
  defaultTriggerEvent: 'REGISTRO_MANUAL',
  // Dias que uma comissão recebível pode ficar sem NFS-e antes de a conferência fiscal abrir issue.
  invoiceGraceDays: 5,
  // O caderno não manda comissão de correspondente entrar na DIMOB (que declara locação). Quem a
  // contabilidade orientar a incluir liga esta opção em Parâmetros; por padrão fica de fora.
  dimobIncludeCommissions: false,
  // O caderno não diz em que etapa do caso uma comissão pode nascer. Por padrão só caso cancelado ou
  // recusado fica impedido; a empresa pode bloquear mais etapas (ex.: rascunho) em Parâmetros.
  blockedCaseStatuses: ['CANCELED', 'REJECTED'],
  // Um direito de comissão ativo por caso e fato gerador (evita duplo clique/chamada repetida). A
  // empresa que parcela a comissão em várias linhas do mesmo fato gerador desliga em Parâmetros.
  blockDuplicateCommissionPerTrigger: true,
  // Quem tem permissão de criar caso não pode, sozinho, confirmar a comissão (gera recebível real no
  // Financeiro): por padrão a confirmação também exige a permissão financeira de liquidar.
  confirmRequiresFinancePermission: true,
  // Prazo (em dias) para o banco pagar a comissão confirmada: define o vencimento do recebível no Financeiro.
  receivableDueDays: 30,
  // Palavras que, na descrição de um lançamento do contrato, indicam cobrança que NÃO é aluguel
  // (não entra na DIMOB). O caderno não define o que compõe o valor declarado.
  // Fiscal (o caderno não define): prazo máximo para cancelar uma NFS-e depois de autorizada (0 = sem prazo;
  // cada município tem o seu), mês do prazo da DIMOB (fevereiro, último dia útil do ano seguinte), dados
  // do serviço enviados ao emissor, tolerância das conferências e qual origem a exportação contábil leva.
  nfseCancelMaxDays: 0,
  dimobDueMonth: 2,
  dimobLayoutLabel: 'DIMOB-{ano}-v1',
  dimobFileColumns: DIMOB_FILE_COLUMNS,
  dimobFileDelimiter: ';',
  dimobFileNotice: DIMOB_FILE_NOTICE_DEFAULT,
  nfseServiceCode: '',
  nfseIssRatePct: 0,
  reconciliationToleranceReais: 0,
  accountingExportSourceMode: 'BOTH',
  // Segregação de funções fiscais: cancelar NFS-e, fechar DIMOB, ajustar a exportação contábil e importar o
  // retorno do contador exigem também a permissão financeira. Por padrão só a permissão fiscal basta.
  fiscalSensitiveRequiresFinance: false,
  dimobExcludedKeywords: ['condomínio', 'condominio', 'iptu', 'multa', 'taxa', 'caução', 'caucao', 'seguro', 'água', 'agua', 'luz'],
  // O caderno cita fatos geradores (contrato assinado, recurso liberado) mas não diz em que etapa do caso
  // cada um pode ser registrado. Lista vazia = qualquer etapa não bloqueada acima.
  caseStatusesByTriggerEvent: {
    CONTRATO_ASSINADO: ['APPROVED', 'CONTRACTING', 'COMPLETED'],
    RECURSO_LIBERADO: ['CONTRACTING', 'COMPLETED'],
    REGISTRO_MANUAL: [],
  },
  // Quanto a base informada pode diferir do valor aprovado da proposta vigente sem exigir justificativa (%).
  baseAmountTolerancePct: 10,
  // Teto do valor-base de uma comissão (proteção contra erro de digitação).
  maxBaseAmount: 1000000000,
  // Conta bancária que recebe as comissões (vazio = o recebível nasce sem conta e a pessoa informa ao receber).
  defaultReceiptBankAccountId: null,
  // Conta do plano de contas em que a receita da comissão é classificada (vazio = sem classificação automática).
  defaultChartOfAccountId: null,
  // Estorno de comissão com NFS-e ainda em andamento (solicitada/enviada/sem resposta): por padrão o estorno
  // espera a nota se resolver; ligado, o estorno segue e a diferença vira divergência fiscal.
  chargebackAllowedWithInvoiceInFlight: false,
};

const ACCOUNTING_EXPORT_SOURCE_MODES = ['BOTH', 'COMMISSION_ONLY', 'NFSE_ONLY', 'NFSE_PREFERRED'];

const TRIGGER_EVENT_LABEL = {
  CONTRATO_ASSINADO: 'Contrato assinado',
  RECURSO_LIBERADO: 'Recurso liberado pelo banco',
  REGISTRO_MANUAL: 'Registro manual',
};

function hashCondition(conditionAstJson) {
  return crypto.createHash('sha256').update(JSON.stringify(conditionAstJson)).digest('hex');
}

async function getOrCreateRule(groupId, companyId, actorUserId, transaction) {
  let rule = await Rule.findOne({ where: { code: RULE_CODE, groupId, companyId }, transaction });
  if (!rule) {
    rule = await Rule.create(
      {
        groupId,
        companyId,
        code: RULE_CODE,
        name: RULE_NAME,
        description: 'Percentual de comissão de correspondente bancário (NC) por provider. Split nunca hard-coded — tudo vem desta regra.',
        domain: RULE_DOMAIN,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }
  return rule;
}

async function publishCommissionSplitVersion(groupId, companyId, action, actorUserId, transaction) {
  const lockKey = COMMISSION_LOCK_KEY(groupId, companyId);
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', {
    replacements: { lockKey },
    transaction,
  });

  const rule = await getOrCreateRule(groupId, companyId, actorUserId, transaction);
  const now = new Date();

  await RuleVersion.update(
    { effectiveUntil: now, updatedBy: actorUserId || null },
    { where: { ruleId: rule.id, status: 'PUBLISHED', effectiveUntil: null }, transaction }
  );

  const lastVersion = await RuleVersion.findOne({ where: { ruleId: rule.id }, order: [['versionNumber', 'DESC']], transaction });
  const nextVersionNumber = lastVersion ? lastVersion.versionNumber + 1 : 1;

  const version = await RuleVersion.create(
    {
      groupId,
      companyId,
      ruleId: rule.id,
      versionNumber: nextVersionNumber,
      conditionAstJson: CONDITION_AST,
      contentHash: hashCondition(CONDITION_AST),
      actionJson: action,
      effectiveFrom: now,
      effectiveUntil: null,
      status: 'PUBLISHED',
      publishedByUserId: actorUserId || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await RuleScope.create(
    {
      groupId,
      companyId,
      ruleVersionId: version.id,
      scopeType: 'GLOBAL',
      scopeRefId: null,
      precedence: 7,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await RulePublication.create(
    {
      groupId,
      companyId,
      ruleVersionId: version.id,
      publishedByUserId: actorUserId || null,
      publishedAt: now,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  return version;
}

const COMMISSION_LOCK_KEY = (groupId, companyId) => `commission_split_rule:${groupId}:${companyId}:${RULE_CODE}`;

async function evaluateCurrent(groupId, companyId, transaction) {
  return evaluateRule(RULE_CODE, { commissionSplitActive: true }, { groupId, companyId }, { transaction });
}

/**
 * Semeia o padrão SÓ quando a regra nunca existiu para a empresa. Regra desativada, arquivada ou com lacuna
 * de vigência não é "sem configuração": republicar o padrão apagaria o que o admin configurou.
 * Reavalia depois de pegar o trava: outra requisição pode ter semeado ou o admin pode ter salvado no meio.
 */
async function evaluateOrSeed(groupId, companyId, actorUserId, transaction) {
  let evaluation = await evaluateCurrent(groupId, companyId, transaction);
  if (evaluation.decision === 'APPLY') return evaluation;
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', {
    replacements: { lockKey: COMMISSION_LOCK_KEY(groupId, companyId) },
    transaction,
  });
  evaluation = await evaluateCurrent(groupId, companyId, transaction);
  if (evaluation.decision === 'APPLY') return evaluation;
  const rule = await Rule.findOne({ where: { code: RULE_CODE, groupId, companyId }, transaction });
  const hasVersion = rule ? Boolean(await RuleVersion.findOne({ where: { ruleId: rule.id }, attributes: ['id'], transaction })) : false;
  if (hasVersion) {
    throw AppError.unprocessable(
      'A regra de comissão da empresa existe mas não está vigente (desativada, arquivada ou com lacuna). Republique os Parâmetros de comissão.',
      'COR_COMMISSION_SPLIT_NOT_CONFIGURED'
    );
  }
  await publishCommissionSplitVersion(groupId, companyId, DEFAULT_ACTION, actorUserId || null, transaction);
  evaluation = await evaluateCurrent(groupId, companyId, transaction);
  if (evaluation.decision !== 'APPLY') {
    throw AppError.unprocessable(
      'Não foi possível resolver o percentual de comissão de correspondente para esta empresa.',
      'COR_COMMISSION_SPLIT_NOT_CONFIGURED'
    );
  }
  return evaluation;
}

/** Parâmetros gerais da comissão (valem para qualquer provider): não dependem do percentual de provider nenhum. */
function normalizeSettings(action) {
  const a = action || {};
  const graceRaw = a.invoiceGraceDays ?? DEFAULT_ACTION.invoiceGraceDays;
  const byTriggerRaw = a.caseStatusesByTriggerEvent && typeof a.caseStatusesByTriggerEvent === 'object' ? a.caseStatusesByTriggerEvent : DEFAULT_ACTION.caseStatusesByTriggerEvent;
  const tolerance = Number(a.baseAmountTolerancePct);
  const maxBase = Number(a.maxBaseAmount);
  return {
    dimobIncludeCommissions: a.dimobIncludeCommissions === true,
    blockDuplicateCommissionPerTrigger: a.blockDuplicateCommissionPerTrigger !== false,
    confirmRequiresFinancePermission: a.confirmRequiresFinancePermission !== false,
    receivableDueDays: Number.isInteger(a.receivableDueDays) && a.receivableDueDays >= 0 ? a.receivableDueDays : DEFAULT_ACTION.receivableDueDays,
    dimobExcludedKeywords: Array.isArray(a.dimobExcludedKeywords) ? a.dimobExcludedKeywords : DEFAULT_ACTION.dimobExcludedKeywords,
    blockedCaseStatuses: Array.isArray(a.blockedCaseStatuses) ? a.blockedCaseStatuses : DEFAULT_ACTION.blockedCaseStatuses,
    invoiceGraceDays: Number.isInteger(Number(graceRaw)) && Number(graceRaw) >= 0 ? Number(graceRaw) : DEFAULT_ACTION.invoiceGraceDays,
    allowedTriggerEvents: Array.isArray(a.allowedTriggerEvents) && a.allowedTriggerEvents.length ? a.allowedTriggerEvents : DEFAULT_ACTION.allowedTriggerEvents,
    defaultTriggerEvent: a.defaultTriggerEvent || DEFAULT_ACTION.defaultTriggerEvent,
    caseStatusesByTriggerEvent: byTriggerRaw,
    baseAmountTolerancePct: Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : DEFAULT_ACTION.baseAmountTolerancePct,
    maxBaseAmount: Number.isFinite(maxBase) && maxBase > 0 ? maxBase : DEFAULT_ACTION.maxBaseAmount,
    defaultReceiptBankAccountId: a.defaultReceiptBankAccountId || null,
    defaultChartOfAccountId: a.defaultChartOfAccountId || null,
    chargebackAllowedWithInvoiceInFlight: a.chargebackAllowedWithInvoiceInFlight === true,
    nfseCancelMaxDays: Number.isInteger(a.nfseCancelMaxDays) && a.nfseCancelMaxDays >= 0 ? a.nfseCancelMaxDays : DEFAULT_ACTION.nfseCancelMaxDays,
    dimobDueMonth: Number.isInteger(a.dimobDueMonth) && a.dimobDueMonth >= 1 && a.dimobDueMonth <= 12 ? a.dimobDueMonth : DEFAULT_ACTION.dimobDueMonth,
    dimobLayoutLabel: typeof a.dimobLayoutLabel === 'string' && a.dimobLayoutLabel.trim() ? a.dimobLayoutLabel : DEFAULT_ACTION.dimobLayoutLabel,
    dimobFileColumns: Array.isArray(a.dimobFileColumns) && a.dimobFileColumns.length && a.dimobFileColumns.every((c) => DIMOB_FILE_COLUMNS.includes(c)) ? a.dimobFileColumns : DEFAULT_ACTION.dimobFileColumns,
    dimobFileDelimiter: DIMOB_FILE_DELIMITERS.includes(a.dimobFileDelimiter) ? a.dimobFileDelimiter : DEFAULT_ACTION.dimobFileDelimiter,
    dimobFileNotice: typeof a.dimobFileNotice === 'string' ? a.dimobFileNotice : DEFAULT_ACTION.dimobFileNotice,
    nfseServiceCode: typeof a.nfseServiceCode === 'string' ? a.nfseServiceCode : DEFAULT_ACTION.nfseServiceCode,
    nfseIssRatePct: Number.isFinite(Number(a.nfseIssRatePct)) && Number(a.nfseIssRatePct) >= 0 ? Number(a.nfseIssRatePct) : DEFAULT_ACTION.nfseIssRatePct,
    reconciliationToleranceReais: Number.isFinite(Number(a.reconciliationToleranceReais)) && Number(a.reconciliationToleranceReais) >= 0 ? Number(a.reconciliationToleranceReais) : DEFAULT_ACTION.reconciliationToleranceReais,
    accountingExportSourceMode: ['BOTH', 'COMMISSION_ONLY', 'NFSE_ONLY', 'NFSE_PREFERRED'].includes(a.accountingExportSourceMode) ? a.accountingExportSourceMode : DEFAULT_ACTION.accountingExportSourceMode,
    fiscalSensitiveRequiresFinance: a.fiscalSensitiveRequiresFinance === true,
  };
}

/** readCommissionSettings — parâmetros gerais vigentes, sem exigir percentual válido de provider. */
async function readCommissionSettings(groupId, companyId, actorUserId, transaction) {
  // Leitura sem pessoa (relatórios como a DIMOB): publicar a regra padrão exige um autor, então, enquanto a
  // empresa não tiver regra vigente, vale o padrão sem gravar nada.
  if (!actorUserId) {
    const current = await evaluateCurrent(groupId, companyId, transaction);
    if (current.decision === 'APPLY') return { ...normalizeSettings(current.action), ruleVersionId: current.ruleVersionId };
    return { ...normalizeSettings(DEFAULT_ACTION), ruleVersionId: null };
  }
  const evaluation = await evaluateOrSeed(groupId, companyId, actorUserId, transaction);
  return { ...normalizeSettings(evaluation.action), ruleVersionId: evaluation.ruleVersionId };
}

/**
 * resolveCommissionSplit — resolve o percentual vigente para `providerCode` via Motor de Regras
 * genérico, com semeadura automática no primeiro uso do tenant (mesmo padrão de
 * resolveEligibilityConfig/REG-EST-002).
 */
async function resolveCommissionSplit(providerCode, groupId, companyId, actorUserId, transaction) {
  const evaluation = await evaluateOrSeed(groupId, companyId, actorUserId, transaction);
  const action = evaluation.action || {};
  const label = providerLabel(providerCode);
  const percentageByProvider = action.percentageByProvider || {};
  const percentage = percentageByProvider[providerCode] ?? action.defaultPercentage;
  if (percentage === undefined || percentage === null || !Number.isFinite(Number(percentage)) || Number(percentage) <= 0) {
    throw AppError.unprocessable(
      `Nenhum percentual de comissão configurado para o provider "${label}".`,
      'COR_COMMISSION_SPLIT_PERCENTAGE_NOT_CONFIGURED'
    );
  }
  // Comissão de correspondente nunca pode exceder 100% da base (erro de digitação do admin, ex.: 150 em vez de 1,5).
  if (Number(percentage) > 100) {
    throw AppError.unprocessable(
      `Percentual de comissão configurado para o provider "${label}" (${percentage}%) está acima do limite de 100%. Corrija a regra de comissão antes de continuar.`,
      'COR_COMMISSION_SPLIT_PERCENTAGE_TOO_HIGH'
    );
  }
  const brokerRaw = (action.brokerSharePctByProvider || {})[providerCode] ?? action.defaultBrokerSharePct ?? 100;
  const brokerSharePct = Number(brokerRaw);
  if (!Number.isFinite(brokerSharePct) || brokerSharePct < 0 || brokerSharePct > 100) {
    throw AppError.unprocessable(
      `A parte do corretor configurada para o provider "${label}" (${brokerRaw}%) precisa estar entre 0% e 100%.`,
      'COR_COMMISSION_SPLIT_BROKER_SHARE_INVALID'
    );
  }
  return {
    ...normalizeSettings(action),
    percentage: Number(percentage),
    brokerSharePct,
    managerSharePct: Math.round((100 - brokerSharePct) * 100) / 100,
    ruleVersionId: evaluation.ruleVersionId,
  };
}

/**
 * getFiscalSettings — parâmetros fiscais da empresa (prazo de cancelamento da NFS-e, mês do prazo da DIMOB,
 * dados do serviço, tolerância das conferências, origem da exportação contábil e segregação de funções).
 * Não depende do percentual de nenhum provider.
 */
async function getFiscalSettings(groupId, companyId, actorUserId, transaction) {
  const s = await readCommissionSettings(groupId, companyId, actorUserId, transaction);
  return {
    nfseCancelMaxDays: s.nfseCancelMaxDays,
    dimobDueMonth: s.dimobDueMonth,
    dimobLayoutLabel: s.dimobLayoutLabel,
    dimobFileColumns: s.dimobFileColumns,
    dimobFileDelimiter: s.dimobFileDelimiter,
    dimobFileNotice: s.dimobFileNotice,
    nfseServiceCode: s.nfseServiceCode,
    nfseIssRatePct: s.nfseIssRatePct,
    reconciliationToleranceReais: s.reconciliationToleranceReais,
    accountingExportSourceMode: s.accountingExportSourceMode,
    fiscalSensitiveRequiresFinance: s.fiscalSensitiveRequiresFinance,
  };
}

/** getInvoiceGraceDays — prazo (em dias) para emitir a NFS-e de uma comissão, vindo da regra vigente. */
async function getInvoiceGraceDays(groupId, companyId, actorUserId, transaction) {
  return (await readCommissionSettings(groupId, companyId, actorUserId, transaction)).invoiceGraceDays;
}

/** getDimobExcludedKeywords — palavras que tiram um lançamento do contrato do valor de aluguel da DIMOB. */
async function getDimobExcludedKeywords(groupId, companyId, actorUserId, transaction) {
  return (await readCommissionSettings(groupId, companyId, actorUserId, transaction)).dimobExcludedKeywords;
}

/** getConfirmRequiresFinancePermission — a confirmação da comissão exige a permissão financeira? */
async function getConfirmRequiresFinancePermission(groupId, companyId, actorUserId, transaction) {
  return (await readCommissionSettings(groupId, companyId, actorUserId, transaction)).confirmRequiresFinancePermission !== false;
}

/** getDimobIncludeCommissions — se as comissões de correspondente entram no DIMOB (parâmetro da empresa). */
async function getDimobIncludeCommissions(groupId, companyId, actorUserId, transaction) {
  return (await readCommissionSettings(groupId, companyId, actorUserId, transaction)).dimobIncludeCommissions === true;
}

module.exports = {
  getDimobExcludedKeywords,
  getConfirmRequiresFinancePermission,
  getDimobIncludeCommissions,
  getInvoiceGraceDays,
  getFiscalSettings,
  resolveCommissionSplit,
  readCommissionSettings,
  normalizeSettings,
  publishCommissionSplitVersion,
  RULE_CODE,
  DEFAULT_ACTION,
  DIMOB_FILE_COLUMNS,
  DIMOB_FILE_DELIMITERS,
  DIMOB_FILE_NOTICE_DEFAULT,
  TRIGGER_EVENT_LABEL,
  ACCOUNTING_EXPORT_SOURCE_MODES,
};
