'use strict';

const crypto = require('crypto');
const { Rule, RuleVersion, RuleScope, RulePublication, Property, sequelize } = require('../../models');
const { safeAudit } = require('./safeAudit');
const AppError = require('../../utils/AppError');
const { evaluateRule } = require('../../engines/rules/rulesEngine');

/**
 * COR_PROVIDER_ELIGIBILITY — Marco 8 Fase 4 (Caderno: "Antes de simular/submeter, chamar Motor
 * de Regras COR_PROVIDER_ELIGIBILITY com produto, finalidade, valor, imóvel/região e provider.
 * Se não elegível, bloquear." / "Elegibilidade de provider vem do Motor de Regras; nenhum banco
 * é hard-coded como obrigatório."). Mesmo padrão arquitetural já usado por REG-EST-002
 * (adjustmentRiskRules.service.js): a regra guarda CONFIGURAÇÃO (quais providers, quais
 * finalidades, teto de valor por provider) no `actionJson`; a decisão de elegível/inelegível
 * para um caso concreto é aplicada aqui em código, usando essa configuração — nunca embutida
 * direto no AST da regra.
 */
const RULE_CODE = 'COR_PROVIDER_ELIGIBILITY';
const RULE_NAME = 'Elegibilidade de provider de financiamento (produto, finalidade, valor)';
const RULE_DOMAIN = 'correspondent';
const CONDITION_AST = { fact: 'eligibilityCheckActive', op: '==', value: true };
const PROVIDER_LABEL = { sandbox: 'Sandbox', manual: 'Manual' };
const PRODUCTS = ['FINANCIAMENTO_IMOBILIARIO', 'REFINANCIAMENTO', 'CREDITO_COM_GARANTIA', 'CONSTRUCAO'];
const PRODUCT_LABEL = {
  FINANCIAMENTO_IMOBILIARIO: 'Financiamento imobiliário',
  REFINANCIAMENTO: 'Refinanciamento',
  CREDITO_COM_GARANTIA: 'Crédito com garantia de imóvel',
  CONSTRUCAO: 'Financiamento de construção',
};
const PURPOSE_LABEL = { RESIDENCIAL: 'Residencial', COMERCIAL: 'Comercial' };

function reais(value) {
  const [inteiro, centavos] = Number(value).toFixed(2).split('.');
  return `${inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${centavos}`;
}

// Semente inicial — nenhum documento fonte define os números exatos ("elegibilidade conforme
// produto/finalidade/valor/provider" não traz limiares); usado só como valor padrão no primeiro
// uso do tenant. Depois de publicada, quem decide é a RuleVersion (editável via
// publishProviderEligibilityVersion, mesmo fluxo de REG-EST-002).
const DEFAULT_ACTION = {
  allowedProviders: ['sandbox', 'manual'],
  allowedPurposes: ['RESIDENCIAL', 'COMERCIAL'],
  allowedProducts: ['FINANCIAMENTO_IMOBILIARIO', 'REFINANCIAMENTO', 'CREDITO_COM_GARANTIA', 'CONSTRUCAO'],
  // null = sem teto de valor para esse provider (ex.: "manual", workflow humano fora do sistema).
  maxAmountByProvider: { sandbox: 2000000, manual: null },
  // O caderno pede "caso duplicado alerta/reusa" e não manda bloquear o envio; quem quiser travar o
  // envio de um caso com possível duplicata pendente de revisão liga esta opção em Parâmetros.
  blockSubmissionOnPendingDuplicate: false,
  // O caderno exige autorização/consentimento "aplicável" e não define a prova. Por padrão basta o
  // aceite registrado (quem e quando); com esta opção a pessoa também precisa dizer como o cliente autorizou.
  requireConsentEvidence: false,
  // Provider sem webhook (ou com webhook perdido) só atualiza o caso se alguém perguntar. Ligado, um
  // job consulta o status (`getCaseStatus`) dos casos em andamento a cada minuto. Padrão desligado.
  statusPollingEnabled: false,
  // Restrição de região configurada para o provider + caso sem imóvel (ou imóvel sem UF): o caderno não
  // diz o que fazer. Por padrão não bloqueia (não há como verificar); ligado, bloqueia.
  blockWhenPropertyRegionUnknown: false,
  // Janela (em horas) em que dois casos do mesmo proponente e imóvel são tratados como possível duplicata.
  duplicateWindowHours: 24,
  // Dias sem atividade para a NAY sinalizar um caso como parado.
  stalledCaseDays: 7,
  // Documentos que o checklist precisa ter (obrigatórios e validados) antes do envio. Vazio = só exige
  // que o checklist não esteja vazio.
  requiredDocumentTypes: [],
  // Minutos que um envio de resultado incerto (UNKNOWN) espera antes de poder ser liberado para novo envio:
  // dá tempo de uma resposta tardia do provider chegar (evita criar o mesmo caso duas vezes).
  unknownReleaseMinutes: 2,
  // Validade (em dias) por tipo de documento: sem data informada no envio, o documento vence nesse prazo e
  // o checklist reabre sozinho ("expiração gera requirement"). Vazio = não vence.
  documentValidityDays: {},
  // Etapas do caso em que o sistema deixa de aceitar documento, simulação e avaliação (o caderno só proíbe
  // em caso cancelado). Caso concluído ou recusado já não evolui; a empresa pode ajustar.
  blockedActionCaseStatuses: ['CANCELED', 'COMPLETED', 'REJECTED'],
  // A avaliação é do imóvel: sem imóvel vinculado ao caso, não há o que avaliar.
  requirePropertyForAppraisal: true,
  // Quem enviou o documento não pode ser quem o valida (segregação de funções). O caderno não exige.
  validatorMustDifferFromUploader: false,
  // Aprovação ou contratação registradas à mão só são aceitas junto com a proposta do banco.
  requireProposalOnApproval: false,
  // Minutos que uma avaliação em andamento espera o provider antes de ser marcada como falha.
  appraisalInProgressMinutes: 10,
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
        description: 'Providers, finalidades e teto de valor por provider elegíveis para financiamento. Nenhum banco é hard-coded como obrigatório — tudo vem desta regra.',
        domain: RULE_DOMAIN,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }
  return rule;
}

async function publishProviderEligibilityVersion(groupId, companyId, action, actorUserId, transaction) {
  const lockKey = `provider_eligibility_rule:${groupId}:${companyId}:${RULE_CODE}`;
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

/**
 * resolveEligibilityConfig — resolve a configuração vigente via Motor de Regras genérico, com
 * semeadura automática do padrão no primeiro uso do tenant (mesmo padrão de
 * getActiveHighValueThreshold/REG-EST-002).
 */
async function resolveEligibilityConfig(groupId, companyId, transaction, actorUserId) {
  let evaluation = await evaluateRule(RULE_CODE, { eligibilityCheckActive: true }, { groupId, companyId }, { transaction });
  if (evaluation.decision !== 'APPLY') {
    // Semeia o padrão só quando a empresa nunca teve a regra. Regra que existe mas não resolve
    // (desativada, arquivada, fora da vigência) NÃO é recriada com os padrões: isso apagaria a
    // configuração do administrador e liberaria providers. Nesse caso o sistema recusa (fail closed).
    const rule = await Rule.findOne({ where: { code: RULE_CODE, groupId, companyId }, transaction });
    const hasVersions = rule ? (await RuleVersion.count({ where: { ruleId: rule.id }, transaction })) > 0 : false;
    if (!hasVersions) {
      await publishProviderEligibilityVersion(groupId, companyId, DEFAULT_ACTION, actorUserId || null, transaction);
      evaluation = await evaluateRule(RULE_CODE, { eligibilityCheckActive: true }, { groupId, companyId }, { transaction });
    }
  }
  if (evaluation.decision !== 'APPLY') {
    throw AppError.unprocessable(
      'A configuração de elegibilidade de provider desta empresa não está vigente. Revise e publique os Parâmetros do correspondente antes de continuar.',
      'COR_ELIGIBILITY_NOT_CONFIGURED'
    );
  }
  // Versões antigas da regra não têm os parâmetros criados depois: valem os padrões para o que faltar.
  return { ruleVersionId: evaluation.ruleVersionId, action: { ...DEFAULT_ACTION, ...evaluation.action } };
}

/**
 * providerTimeoutMs — tempo máximo de espera do provider, vindo dos Parâmetros (segundos). Valor
 * ausente, não numérico ou fora de 1–120 s cai no padrão: um NaN faria o timer disparar na hora e
 * todo envio virar incerto.
 */
function providerTimeoutMs(action) {
  const seconds = Number(action?.providerTimeoutSeconds);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120) return DEFAULT_ACTION.providerTimeoutSeconds * 1000;
  return Math.round(seconds * 1000);
}

/** getProviderTimeoutMs — lê a configuração vigente (sem semear) e devolve o tempo de espera em ms. */
async function getProviderTimeoutMs(groupId, companyId, transaction) {
  return providerTimeoutMs(await peekEligibilityConfig(groupId, companyId, transaction));
}

/**
 * assertEligible — FAIL CLOSED: bloqueia com motivo claro em português sempre que o
 * provider/finalidade/valor do caso não baterem com a configuração vigente da regra. Chamado
 * ANTES de simular (Fase 3) e será chamado ANTES de submeter (Fase 5, ainda não implementada).
 * `financingCase` precisa ter `providerCode` e `purpose`; `amount` é o valor sendo
 * simulado/submetido (não necessariamente igual em toda chamada — cada simulação pode ter um
 * valor diferente).
 */
async function assertEligible(financingCase, { amount, skipAmount = false } = {}, groupId, companyId, actorUserId, transaction) {
  const { action, ruleVersionId } = await resolveEligibilityConfig(groupId, companyId, transaction, actorUserId);

  const providerCode = financingCase.providerCode;
  const purpose = financingCase.purpose || 'RESIDENCIAL';

  const allowedProviders = Array.isArray(action.allowedProviders) ? action.allowedProviders : [];
  if (!allowedProviders.includes(providerCode)) {
    await logIneligible(groupId, companyId, actorUserId, financingCase.id, ruleVersionId, `Provider "${PROVIDER_LABEL[providerCode] || providerCode}" não está habilitado para elegibilidade de financiamento.`, transaction);
    throw AppError.unprocessable(
      `O provider "${PROVIDER_LABEL[providerCode] || providerCode}" não está elegível para financiamento no momento. Fale com o administrador do sistema para habilitar este provider.`,
      'COR_ELIGIBILITY_PROVIDER_NOT_ALLOWED'
    );
  }

  // Produto (o caderno lista "produto" entre os critérios): configuração antiga sem a lista aceita todos.
  const product = financingCase.product || 'FINANCIAMENTO_IMOBILIARIO';
  const allowedProducts = Array.isArray(action.allowedProducts) ? action.allowedProducts : PRODUCTS;
  if (!allowedProducts.includes(product)) {
    await logIneligible(groupId, companyId, actorUserId, financingCase.id, ruleVersionId, `Produto "${product}" não está elegível para financiamento.`, transaction);
    throw AppError.unprocessable(
      `O produto "${PRODUCT_LABEL[product] || product}" deste caso não está elegível no momento.`,
      'COR_ELIGIBILITY_PRODUCT_NOT_ALLOWED'
    );
  }

  const allowedPurposes = Array.isArray(action.allowedPurposes) ? action.allowedPurposes : [];
  if (!allowedPurposes.includes(purpose)) {
    await logIneligible(groupId, companyId, actorUserId, financingCase.id, ruleVersionId, `Finalidade "${purpose}" não está elegível para financiamento.`, transaction);
    throw AppError.unprocessable(
      `A finalidade "${PURPOSE_LABEL[purpose] || purpose}" deste caso não está elegível para financiamento no momento.`,
      'COR_ELIGIBILITY_PURPOSE_NOT_ALLOWED'
    );
  }

  // GAP REAL FECHADO (18/10/2026 — CORRESPONDENT-ELIG-09 falhava porque esta checagem nunca
  // tinha sido implementada, só o teste existia): elegibilidade por REGIÃO. Quando a
  // RuleVersion define allowedStatesByProvider para o provider E o caso tem imóvel vinculado,
  // a UF do imóvel precisa estar na lista — fora dela, bloqueia com motivo claro. Sem
  // configuração de região pro provider (undefined/null) nada muda: a regra é opt-in, como os
  // demais limiares desta mesma regra.
  const allowedStatesByProvider = action.allowedStatesByProvider || {};
  const allowedStates = allowedStatesByProvider[providerCode];
  if (Array.isArray(allowedStates) && allowedStates.length > 0) {
    const property = financingCase.propertyId
      ? await Property.findOne({ where: { id: financingCase.propertyId, groupId, companyId }, transaction })
      : null;
    const propertyState = property?.state ? String(property.state).toUpperCase() : null;
    // Restrição por região configurada: sem imóvel (ou imóvel sem UF) não há como provar que a
    // região é atendida, então bloqueia em vez de deixar passar.
    if (!propertyState && action.blockWhenPropertyRegionUnknown === true) {
      await logIneligible(groupId, companyId, actorUserId, financingCase.id, ruleVersionId, `Provider "${PROVIDER_LABEL[providerCode] || providerCode}" só atende as UFs ${allowedStates.join(', ')} e o caso não tem imóvel com UF cadastrada.`, transaction);
      throw AppError.unprocessable(
        `O provider "${PROVIDER_LABEL[providerCode] || providerCode}" só atende as UFs ${allowedStates.join(', ')}. Vincule ao caso um imóvel com UF cadastrada antes de continuar.`,
        'COR_ELIGIBILITY_REGION_UNKNOWN'
      );
    }
    if (propertyState && !allowedStates.map((uf) => String(uf).toUpperCase()).includes(propertyState)) {
      await logIneligible(
        groupId,
        companyId,
        actorUserId,
        financingCase.id,
        ruleVersionId,
        `Imóvel na UF "${propertyState}" fora das regiões habilitadas (${allowedStates.join(', ')}) para o provider "${PROVIDER_LABEL[providerCode] || providerCode}".`,
        transaction
      );
      throw AppError.unprocessable(
        `O imóvel deste caso fica em ${propertyState}, fora das regiões habilitadas para o provider "${PROVIDER_LABEL[providerCode] || providerCode}" (${allowedStates.join(', ')}).`,
        'COR_ELIGIBILITY_REGION_NOT_ALLOWED'
      );
    }
  }

  const maxAmountByProvider = action.maxAmountByProvider || {};
  const maxAmount = skipAmount ? null : maxAmountByProvider[providerCode];
  if (maxAmount !== null && maxAmount !== undefined) {
    // Teto gravado de forma inválida (configuração antiga): recusa em vez de comparar com NaN e deixar passar.
    if (!Number.isFinite(Number(maxAmount)) || Number(maxAmount) <= 0) {
      throw AppError.unprocessable(
        `O teto de valor configurado para o provider "${PROVIDER_LABEL[providerCode] || providerCode}" é inválido. Corrija em Parâmetros do correspondente.`,
        'COR_ELIGIBILITY_NOT_CONFIGURED'
      );
    }
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw AppError.badRequest(
        'Nenhum valor disponível para checar elegibilidade. Informe o valor da operação (ou rode uma simulação neste provider) antes de enviar.',
        'SUBMISSION_VALIDATION'
      );
    }
  }
  if (maxAmount !== null && maxAmount !== undefined && Number(amount) > Number(maxAmount)) {
    await logIneligible(
      groupId,
      companyId,
      actorUserId,
      financingCase.id,
      ruleVersionId,
      `Valor R$ ${reais(amount)} acima do teto de R$ ${reais(maxAmount)} para o provider "${PROVIDER_LABEL[providerCode] || providerCode}".`,
      transaction
    );
    throw AppError.unprocessable(
      `O valor solicitado (R$ ${reais(amount)}) está acima do limite aceito pelo provider "${PROVIDER_LABEL[providerCode] || providerCode}" (até R$ ${reais(maxAmount)}). Tente um provider diferente ou ajuste o valor.`,
      'COR_ELIGIBILITY_AMOUNT_EXCEEDS_LIMIT'
    );
  }

  return { eligible: true, ruleVersionId };
}

async function logIneligible(groupId, companyId, actorUserId, financingCaseId, ruleVersionId, reason, transaction) {
  if (!groupId || !companyId) return;
  const entry = {
    groupId,
    companyId,
    actorUserId,
    action: 'correspondent.eligibility.denied',
    entityType: 'FinancingCase',
    entityId: financingCaseId,
    reason: `Caso bloqueado por inelegibilidade (${RULE_CODE}, versão ${ruleVersionId || 'n/d'}): ${reason}`,
  };
  // O bloqueio devolve erro e, na requisição HTTP, a transação inteira volta (a auditoria escrita
  // dentro dela some). Por isso a entrada também fica anotada na transação: o middleware de tenant
  // a regrava numa transação nova logo depois do rollback ("provider errado → eligibility + audit").
  if (transaction) {
    transaction.afterRollbackAudits = [...(transaction.afterRollbackAudits || []), entry];
  }
  await safeAudit(entry, transaction);
}

/**
 * peekEligibilityConfig — leitura SEM semear: devolve a configuração vigente ou o padrão, nunca
 * escreve (seguro para consultas de leitura, inclusive de outra empresa, e não aborta transação).
 */
async function peekEligibilityConfig(groupId, companyId, transaction) {
  const evaluation = await evaluateRule(RULE_CODE, { eligibilityCheckActive: true }, { groupId, companyId }, { transaction });
  return evaluation.decision === 'APPLY' ? { ...DEFAULT_ACTION, ...evaluation.action } : { ...DEFAULT_ACTION };
}

module.exports = {
  peekEligibilityConfig,
  assertEligible,
  resolveEligibilityConfig,
  publishProviderEligibilityVersion,
  providerTimeoutMs,
  getProviderTimeoutMs,
  PROVIDER_LABEL,
  RULE_CODE,
  DEFAULT_ACTION,
  PRODUCTS,
  PRODUCT_LABEL,
};
