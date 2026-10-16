'use strict';

const { sequelize, Group, Company, Guarantee, LegalCase, Notification } = require('../../models');
const { publishGuaranteeExpiring } = require('../../features/legal/legalEvents.service');
const { getSetting } = require('../../features/settings/settings.service');
const { registrarAuditoria } = require('../audit/auditLog.service');

/**
 * legalGuaranteeExpiryAlertJob — auditoria externa (contrato bruto, Anexo I "9. Garantias
 * locatícias" e "JUR-TS-005 Garantia vencida"): "Garantia vencendo gera tarefas/eventos."
 * Hoje `legal.guarantees` tem vigência (startsAt/endsAt) mas nada varria essas datas
 * proativamente — só na hora em que alguém abria a tela de ativação do contrato (assertActivationGate)
 * é que o fato de a garantia estar vencida/cancelada tinha efeito. Este job, no MESMO padrão de
 * legalDeadlineAlertJob.js, varre garantias ACTIVE perto do vencimento e dispara
 * `lease.guarantee.expiring` + uma Notification IN_APP para o responsável do contrato (quando
 * houver um LegalCase vinculado com responsável definido) ou, na ausência de um, fica só o
 * evento de domínio auditável.
 *
 * Antecedência CONFIGURÁVEL por tenant (`legal.guarantee_expiry_alert_days`, default 30 dias) —
 * decisão de engenharia documentada: o Caderno pede "alerta" sem fixar um número de dias; "não
 * fixa" significa que o número correto varia por operação (ex.: seguro-fiança negocia renovação
 * com mais antecedência que caução). Fail-safe: getSetting nunca lança, cai no default se ausente.
 */
const DEFAULT_ALERT_DAYS = 30;

async function processGuaranteesInTransaction(transaction, nowOverride) {
  const now = nowOverride || new Date();

  const guarantees = await Guarantee.findAll({ where: { status: 'ACTIVE' }, transaction });
  let alerted = 0;

  for (const guarantee of guarantees) {
    if (!guarantee.endsAt) continue; // garantia sem vigência definida nunca "vence" automaticamente.

    const tenantAlertDays = Number(
      (await getSetting('legal.guarantee_expiry_alert_days', { companyId: guarantee.companyId }, transaction, DEFAULT_ALERT_DAYS)) ||
        DEFAULT_ALERT_DAYS
    );

    const endsAt = new Date(guarantee.endsAt);
    const msUntilExpiry = endsAt.getTime() - now.getTime();
    const daysUntilExpiry = Math.ceil(msUntilExpiry / (1000 * 60 * 60 * 24));

    // Fail closed: só alerta dentro da janela configurada (inclui já vencida — JUR-TS-005
    // "Garantia vencida" também precisa continuar alertando, não só "está prestes a vencer").
    if (daysUntilExpiry > tenantAlertDays) continue;

    await publishGuaranteeExpiring(guarantee, daysUntilExpiry, transaction);

    const legalCase = await LegalCase.findOne({ where: { contractId: guarantee.contractId }, transaction });
    if (legalCase && legalCase.responsibleUserId) {
      await Notification.create(
        {
          groupId: guarantee.groupId,
          companyId: guarantee.companyId,
          userId: legalCase.responsibleUserId,
          channel: 'IN_APP',
          title: daysUntilExpiry < 0 ? 'Garantia VENCIDA' : 'Garantia próxima do vencimento',
          body:
            daysUntilExpiry < 0
              ? `Garantia "${guarantee.guaranteeType}" do contrato ${guarantee.contractId} está vencida desde ${endsAt.toLocaleDateString('pt-BR')}.`
              : `Garantia "${guarantee.guaranteeType}" do contrato ${guarantee.contractId} vence em ${endsAt.toLocaleDateString('pt-BR')} (${daysUntilExpiry} dia(s)).`,
          createdBy: null,
          updatedBy: null,
        },
        { transaction }
      );
    }

    await registrarAuditoria(
      {
        groupId: guarantee.groupId,
        companyId: guarantee.companyId,
        actorUserId: null,
        action: 'legal.guarantee.job_expiry_alert',
        entityType: 'Guarantee',
        entityId: guarantee.id,
        afterJson: { endsAt: guarantee.endsAt, daysUntilExpiry },
        reason: `Job automático de garantias alertou vencimento (${daysUntilExpiry} dia(s)) da garantia "${guarantee.guaranteeType}".`,
      },
      transaction
    );

    alerted += 1;
  }

  return { guaranteesChecked: guarantees.length, alerted };
}

async function processCompany(group, company) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return processGuaranteesInTransaction(transaction);
  });
}

async function runLegalGuaranteeExpiryAlertJob() {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, guaranteesChecked: 0, alerted: 0, errors: 0 };

  for (const group of groups) {
    summary.groupsChecked += 1;
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });

    for (const company of companies) {
      summary.companiesChecked += 1;
      try {
        const result = await processCompany(group, company);
        summary.guaranteesChecked += result.guaranteesChecked;
        summary.alerted += result.alerted;
      } catch (err) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[LegalGuaranteeExpiryAlertJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${err.message}`
        );
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[LegalGuaranteeExpiryAlertJob] Execução concluída — ${summary.groupsChecked} grupo(s), ${summary.companiesChecked} empresa(s), ` +
      `${summary.guaranteesChecked} garantia(s) verificada(s), ${summary.alerted} alerta(s) novo(s), ${summary.errors} erro(s).`
  );

  return summary;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hora

function startLegalGuaranteeExpiryAlertJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  runLegalGuaranteeExpiryAlertJob().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[LegalGuaranteeExpiryAlertJob] Falha na execução inicial:', err.message);
  });

  return setInterval(() => {
    runLegalGuaranteeExpiryAlertJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[LegalGuaranteeExpiryAlertJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = {
  runLegalGuaranteeExpiryAlertJob,
  startLegalGuaranteeExpiryAlertJob,
  processLegalGuaranteeExpiryAlertsForCompany: processCompany,
  processGuaranteesInTransaction,
  DEFAULT_ALERT_DAYS,
};
