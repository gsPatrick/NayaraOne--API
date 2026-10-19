'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const {
  sequelize,
  BillingSchedule,
  CollectionCase,
  CollectionCadenceStep,
  Contract,
  Notification,
  Task,
  Rule,
  RuleVersion,
  RuleScope,
  RulePublication,
} = require('../../models');
const AppError = require('../../utils/AppError');
const { evaluateRule } = require('../../engines/rules/rulesEngine');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishDomainEvent } = require('../../engines/events/outbox');

/**
 * Cadência de cobrança de locação — régua por etapas via Motor de Regras (REG-LOC-004).
 *
 * Caderno p.158: "Multa/juros/grace/cadência via Motor de Regras; acordo versionado não apaga
 * dívida." O Caderno não define as etapas nem os prazos. DECISÃO DE ENGENHARIA documentada: a
 * régua padrão abaixo é um default razoável do mercado de locação, publicado como versão 1 da
 * regra e ajustável sem mudar código (nova RuleVersion via publishCadenceRuleVersion):
 *   - REMINDER_D-3  3 dias antes do vencimento   lembrete (notificação interna)
 *   - NOTICE_D1     1 dia depois do vencimento   aviso de atraso (notificação interna)
 *   - NOTICE_D5     5 dias depois                segundo aviso (notificação interna)
 *   - TASK_D15      15 dias depois               tarefa de cobrança ativa para o responsável
 *   - LEGAL_D30     30 dias depois               tarefa urgente para avaliar cobrança jurídica
 * Nenhuma etapa envia nada para fora do sistema: o efeito é Notification/Task internas e um
 * evento `charge.cadence_step` no outbox (integrações externas leem dali, com revisão humana).
 *
 * Regras de execução:
 *  - Cada etapa roda no máximo UMA vez por competência (UNIQUE billing_schedule_id+step_code).
 *  - A competência fica presa à versão da regra em que a cadência começou; uma nova versão vale
 *    para as competências que ainda não tiveram nenhuma etapa (novos ciclos).
 *  - Competência paga, sem saldo, ou com caso de cobrança em ACORDO/RESOLVIDO não recebe etapa.
 *  - Se o job ficou parado e várias etapas venceram, só a mais avançada executa; as anteriores
 *    são registradas como SKIPPED_SUPERSEDED (sem efeito) — nunca três avisos de uma vez.
 *    Lembretes de antes do vencimento que não rodaram a tempo também viram SKIPPED.
 *  - A cadência nunca altera valor: billing_schedule e collection_case não são escritos aqui.
 */

const RULE_CODE = 'REG-LOC-004';
const RULE_NAME = 'Cadência de cobrança de locação';
const RULE_DOMAIN = 'finance';
const CONDITION_AST = { fact: 'collectionCadenceRuleActive', op: '==', value: true };
const ACTIONS = ['NOTIFY', 'TASK', 'ESCALATE_LEGAL'];

const DEFAULT_CADENCE_STEPS = [
  { code: 'REMINDER_D-3', offsetDays: -3, action: 'NOTIFY' },
  { code: 'NOTICE_D1', offsetDays: 1, action: 'NOTIFY' },
  { code: 'NOTICE_D5', offsetDays: 5, action: 'NOTIFY' },
  { code: 'TASK_D15', offsetDays: 15, action: 'TASK' },
  { code: 'LEGAL_D30', offsetDays: 30, action: 'ESCALATE_LEGAL' },
];

const STEP_CODE_PATTERN = /^[A-Z0-9_-]{2,40}$/;
const MIN_OFFSET = -30;
const MAX_OFFSET = 365;

function validateCadenceSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 20) {
    throw AppError.badRequest('A cadência precisa ter de 1 a 20 etapas.', 'COLLECTION_CADENCE_INVALID');
  }
  const codes = new Set();
  const offsets = new Set();
  const normalized = steps.map((step) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw AppError.badRequest('Cada etapa da cadência precisa ser um objeto.', 'COLLECTION_CADENCE_INVALID');
    }
    const code = String(step.code || '');
    if (!STEP_CODE_PATTERN.test(code)) {
      throw AppError.badRequest(`Código de etapa inválido: "${code}".`, 'COLLECTION_CADENCE_INVALID');
    }
    if (!Number.isInteger(step.offsetDays) || step.offsetDays < MIN_OFFSET || step.offsetDays > MAX_OFFSET) {
      throw AppError.badRequest(
        `A etapa "${code}" precisa de um prazo inteiro em dias entre ${MIN_OFFSET} e ${MAX_OFFSET}.`,
        'COLLECTION_CADENCE_INVALID'
      );
    }
    if (step.offsetDays === 0) {
      throw AppError.badRequest(
        `A etapa "${code}" não pode ser no próprio dia do vencimento (o aluguel ainda não está atrasado).`,
        'COLLECTION_CADENCE_INVALID'
      );
    }
    if (!ACTIONS.includes(step.action)) {
      throw AppError.badRequest(`Ação inválida na etapa "${code}": use ${ACTIONS.join(', ')}.`, 'COLLECTION_CADENCE_INVALID');
    }
    if (codes.has(code) || offsets.has(step.offsetDays)) {
      throw AppError.badRequest('Códigos e prazos das etapas não podem se repetir.', 'COLLECTION_CADENCE_INVALID');
    }
    codes.add(code);
    offsets.add(step.offsetDays);
    return { code, offsetDays: step.offsetDays, action: step.action };
  });
  return normalized.sort((a, b) => a.offsetDays - b.offsetDays);
}

function hashCondition(conditionAstJson) {
  return crypto.createHash('sha256').update(JSON.stringify(conditionAstJson)).digest('hex');
}

/**
 * publishCadenceRuleVersion — publica uma nova versão da régua (mesmo padrão de
 * slaRules.service.js#publishSlaRuleVersion: advisory lock, fecha a vigente, cria a nova
 * PUBLISHED com escopo GLOBAL). Competências já em cadência continuam na versão em que
 * começaram.
 */
async function publishCadenceRuleVersion(groupId, companyId, steps, actorUserId, transaction) {
  const normalized = validateCadenceSteps(steps);
  const lockKey = `collection_cadence_rule:${groupId}:${companyId}:${RULE_CODE}`;
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', { replacements: { lockKey }, transaction });

  let rule = await Rule.findOne({ where: { code: RULE_CODE, groupId, companyId }, transaction });
  if (!rule) {
    rule = await Rule.create(
      {
        groupId,
        companyId,
        code: RULE_CODE,
        name: RULE_NAME,
        description: 'Etapas da régua de cobrança de uma competência de locação (lembrete, avisos, tarefa, escalonamento jurídico).',
        domain: RULE_DOMAIN,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }

  const now = new Date();
  await RuleVersion.update(
    { effectiveUntil: now, updatedBy: actorUserId || null },
    { where: { ruleId: rule.id, status: 'PUBLISHED', effectiveUntil: null }, transaction }
  );
  const lastVersion = await RuleVersion.findOne({ where: { ruleId: rule.id }, order: [['versionNumber', 'DESC']], transaction });
  const version = await RuleVersion.create(
    {
      groupId,
      companyId,
      ruleId: rule.id,
      versionNumber: lastVersion ? lastVersion.versionNumber + 1 : 1,
      conditionAstJson: CONDITION_AST,
      contentHash: hashCondition(CONDITION_AST),
      actionJson: { steps: normalized },
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
    { groupId, companyId, ruleVersionId: version.id, scopeType: 'GLOBAL', scopeRefId: null, precedence: 7, createdBy: actorUserId || null, updatedBy: actorUserId || null },
    { transaction }
  );
  await RulePublication.create(
    { groupId, companyId, ruleVersionId: version.id, publishedByUserId: actorUserId || null, publishedAt: now, createdBy: actorUserId || null, updatedBy: actorUserId || null },
    { transaction }
  );
  return version;
}

/** Data de negócio (calendário de São Paulo) no formato YYYY-MM-DD. */
function businessDateSaoPaulo(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function daysBetweenDates(fromYmd, toYmd) {
  const from = Date.UTC(Number(fromYmd.slice(0, 4)), Number(fromYmd.slice(5, 7)) - 1, Number(fromYmd.slice(8, 10)));
  const to = Date.UTC(Number(toYmd.slice(0, 4)), Number(toYmd.slice(5, 7)) - 1, Number(toYmd.slice(8, 10)));
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

function addDaysYmd(ymd, days) {
  const base = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function formatBRL(value) {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDateBR(ymd) {
  return `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;
}

/**
 * Qual régua vale para esta competência: a versão já usada nela (se a cadência já começou) ou a
 * versão vigente da REG-LOC-004 no Motor de Regras (fail-closed: sem regra publicada, nada roda).
 */
async function resolveCadenceForSchedule(schedule, existingSteps, now, transaction) {
  if (existingSteps.length > 0) {
    const pinnedVersion = await RuleVersion.findByPk(existingSteps[0].ruleVersionId, { transaction });
    if (!pinnedVersion) return null;
    return { ruleVersionId: pinnedVersion.id, steps: validateCadenceSteps(pinnedVersion.actionJson && pinnedVersion.actionJson.steps) };
  }
  const evaluation = await evaluateRule(
    RULE_CODE,
    { collectionCadenceRuleActive: true },
    { groupId: schedule.groupId, companyId: schedule.companyId },
    { transaction, now }
  );
  if (evaluation.decision !== 'APPLY') return null;
  return { ruleVersionId: evaluation.ruleVersionId, steps: validateCadenceSteps(evaluation.action && evaluation.action.steps) };
}

/**
 * Decide quais etapas executar e quais pular hoje, dado o número de dias desde o vencimento.
 * Função pura (testada diretamente).
 */
function planSteps(steps, daysFromDue, alreadyRecorded) {
  const pending = steps.filter((step) => !alreadyRecorded.has(step.code));
  const toExecute = [];
  const toSkip = [];

  const reminders = pending.filter((step) => step.offsetDays < 0);
  for (const step of reminders) {
    if (daysFromDue >= 0) toSkip.push(step);
  }
  const dueReminders = reminders.filter((step) => daysFromDue < 0 && daysFromDue >= step.offsetDays);
  if (dueReminders.length > 0) {
    const latest = dueReminders[dueReminders.length - 1];
    toExecute.push(latest);
    dueReminders.slice(0, -1).forEach((step) => toSkip.push(step));
  }

  const dueOverdue = pending.filter((step) => step.offsetDays > 0 && daysFromDue >= step.offsetDays);
  if (dueOverdue.length > 0) {
    const latest = dueOverdue[dueOverdue.length - 1];
    toExecute.push(latest);
    dueOverdue.slice(0, -1).forEach((step) => toSkip.push(step));
  }

  return { toExecute, toSkip };
}

function describeStep(step, schedule, daysFromDue) {
  const amount = formatBRL(schedule.balance);
  const due = formatDateBR(String(schedule.dueDate));
  const period = schedule.period;
  if (step.offsetDays < 0) {
    return {
      title: `Aluguel da competência ${period} vence em ${Math.abs(daysFromDue)} dia(s)`,
      body: `Lembrete: a cobrança da competência ${period} (${amount}) vence em ${due}.`,
    };
  }
  if (step.action === 'NOTIFY') {
    return {
      title: `Aluguel da competência ${period} em atraso há ${daysFromDue} dia(s)`,
      body: `A cobrança da competência ${period}, vencida em ${due}, está em aberto: saldo de ${amount}. Contate o locatário.`,
    };
  }
  if (step.action === 'TASK') {
    return {
      title: `Cobrar aluguel em atraso — competência ${period} (${daysFromDue} dias)`,
      body: `A competência ${period}, vencida em ${due}, segue em aberto com saldo de ${amount}. Faça a cobrança ativa e registre o retorno (acordo, pagamento ou contestação).`,
    };
  }
  return {
    title: `Avaliar cobrança jurídica — competência ${period} (${daysFromDue} dias em atraso)`,
    body: `A competência ${period}, vencida em ${due}, completou ${daysFromDue} dias em atraso com saldo de ${amount}. Avalie o encaminhamento ao jurídico (notificação extrajudicial/ação). Nada é enviado automaticamente.`,
  };
}

async function executeStep(step, schedule, contract, cadence, daysFromDue, businessDate, transaction) {
  const responsibleUserId = (contract && contract.createdBy) || schedule.createdBy || null;
  const text = describeStep(step, schedule, daysFromDue);
  let notificationId = null;
  let taskId = null;

  if (responsibleUserId && step.action === 'NOTIFY') {
    const notification = await Notification.create(
      { groupId: schedule.groupId, companyId: schedule.companyId, userId: responsibleUserId, channel: 'IN_APP', title: text.title, body: text.body },
      { transaction }
    );
    notificationId = notification.id;
  }
  if (step.action === 'TASK' || step.action === 'ESCALATE_LEGAL') {
    const task = await Task.create(
      {
        groupId: schedule.groupId,
        companyId: schedule.companyId,
        assignedToUserId: responsibleUserId,
        title: text.title,
        description: text.body,
        relatedEntityType: 'finance.billing_schedules',
        relatedEntityId: schedule.id,
        status: 'OPEN',
        priority: step.action === 'ESCALATE_LEGAL' ? 'URGENT' : 'HIGH',
      },
      { transaction }
    );
    taskId = task.id;
  }

  const record = await CollectionCadenceStep.create(
    {
      groupId: schedule.groupId,
      companyId: schedule.companyId,
      billingScheduleId: schedule.id,
      contractId: schedule.contractId,
      ruleVersionId: cadence.ruleVersionId,
      stepCode: step.code,
      offsetDays: step.offsetDays,
      action: step.action,
      outcome: 'EXECUTED',
      businessDate,
      daysFromDue,
      balanceAtStep: schedule.balance,
      notificationId,
      taskId,
    },
    { transaction }
  );

  await publishDomainEvent(
    {
      groupId: schedule.groupId,
      companyId: schedule.companyId,
      aggregateType: 'BillingSchedule',
      aggregateId: schedule.id,
      eventType: 'charge.cadence_step',
      payload: {
        billingScheduleId: schedule.id,
        contractId: schedule.contractId,
        period: schedule.period,
        stepCode: step.code,
        action: step.action,
        daysFromDue,
        balance: String(schedule.balance),
        ruleVersionId: cadence.ruleVersionId,
      },
      idempotencyKey: `charge.cadence_step:${schedule.id}:${step.code}`,
    },
    transaction
  );

  await registrarAuditoria(
    {
      groupId: schedule.groupId,
      companyId: schedule.companyId,
      actorUserId: null,
      action: 'billing.collection_cadence.step',
      entityType: 'BillingSchedule',
      entityId: schedule.id,
      afterJson: record.toJSON(),
      reason: `Etapa de cobrança ${step.code} executada (${daysFromDue} dia(s) em relação ao vencimento, saldo ${formatBRL(schedule.balance)}).`,
    },
    transaction
  );

  return record;
}

async function recordSkipped(step, schedule, cadence, daysFromDue, businessDate, transaction) {
  return CollectionCadenceStep.create(
    {
      groupId: schedule.groupId,
      companyId: schedule.companyId,
      billingScheduleId: schedule.id,
      contractId: schedule.contractId,
      ruleVersionId: cadence.ruleVersionId,
      stepCode: step.code,
      offsetDays: step.offsetDays,
      action: step.action,
      outcome: 'SKIPPED_SUPERSEDED',
      businessDate,
      daysFromDue,
      balanceAtStep: schedule.balance,
    },
    { transaction }
  );
}

const BLOCKING_CASE_STATUSES = ['AGREEMENT', 'RESOLVED'];

/**
 * runCollectionCadence — avalia as competências em aberto da empresa já configurada na
 * transação (SET LOCAL app.company_id) e executa as etapas da régua que venceram hoje.
 */
async function runCollectionCadence(transaction, { now = new Date(), contractId = null } = {}) {
  const businessDate = businessDateSaoPaulo(now);
  const horizon = addDaysYmd(businessDate, -MIN_OFFSET);

  const where = {
    status: { [Op.ne]: 'PAID' },
    balance: { [Op.gt]: 0 },
    dueDate: { [Op.lte]: horizon },
  };
  // Filtro opcional por contrato: rodar a régua de um contrato só (reprocessamento manual).
  if (contractId) where.contractId = contractId;

  const candidates = await BillingSchedule.findAll({
    where,
    order: [['due_date', 'ASC']],
    transaction,
  });

  const summary = { schedulesChecked: candidates.length, executed: 0, skipped: 0, blocked: 0, errors: 0 };

  // Uma savepoint por competência: falha numa não impede as demais (mesmo padrão de
  // toolLoanOverdueJob). A trava FOR UPDATE na competência serializa duas execuções simultâneas
  // do job (várias réplicas) — a segunda relê as etapas já gravadas e não repete nenhuma.
  for (const candidate of candidates) {
    try {
      await processSchedule(candidate, transaction, now, businessDate, summary);
    } catch (err) {
      summary.errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[CollectionCadence] Falha na competência ${candidate.id}: ${err.message}`);
    }
  }

  return summary;
}

async function processSchedule(candidate, transaction, now, businessDate, summary) {
  await sequelize.transaction({ transaction }, async (nested) => {
    const schedule = await BillingSchedule.findByPk(candidate.id, { transaction: nested, lock: nested.LOCK.UPDATE });
    if (!schedule || schedule.status === 'PAID' || Number(schedule.balance) <= 0) return;

    const collectionCase = await CollectionCase.findOne({ where: { billingScheduleId: schedule.id }, transaction: nested });
    if (collectionCase && BLOCKING_CASE_STATUSES.includes(collectionCase.status)) {
      summary.blocked += 1;
      return;
    }

    const existingSteps = await CollectionCadenceStep.findAll({
      where: { billingScheduleId: schedule.id },
      order: [['created_at', 'ASC']],
      transaction: nested,
    });
    const cadence = await resolveCadenceForSchedule(schedule, existingSteps, now, nested);
    if (!cadence) return;

    const daysFromDue = daysBetweenDates(String(schedule.dueDate), businessDate);
    const recorded = new Set(existingSteps.map((step) => step.stepCode));
    const { toExecute, toSkip } = planSteps(cadence.steps, daysFromDue, recorded);
    if (toExecute.length === 0 && toSkip.length === 0) return;

    const contract = await Contract.findByPk(schedule.contractId, { transaction: nested });
    for (const step of toSkip) {
      await recordSkipped(step, schedule, cadence, daysFromDue, businessDate, nested);
      summary.skipped += 1;
    }
    for (const step of toExecute) {
      await executeStep(step, schedule, contract, cadence, daysFromDue, businessDate, nested);
      summary.executed += 1;
    }
  });
}

async function listCadenceSteps(billingScheduleId, transaction) {
  return CollectionCadenceStep.findAll({ where: { billingScheduleId }, order: [['created_at', 'ASC']], transaction });
}

module.exports = {
  RULE_CODE,
  DEFAULT_CADENCE_STEPS,
  validateCadenceSteps,
  publishCadenceRuleVersion,
  planSteps,
  businessDateSaoPaulo,
  runCollectionCadence,
  listCadenceSteps,
};
