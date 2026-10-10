'use strict';

const { Op } = require('sequelize');
const { sequelize, Group, Company, InsurancePolicy, Notification } = require('../../models');
const { registrarAuditoria } = require('../audit/auditLog.service');
const { todayDateOnly, POLICY_STATUSES_ELIGIBLE_FOR_CLAIM } = require('../../features/procurement/insurance.service');

/**
 * insurancePolicyExpiryJob (Marco 7 — Insurance Hub, contrato Anexo I: "Apólice com ...
 * vigência ... renovação alerta").
 *
 * GAP REAL CORRIGIDO (auditoria contrato Marco 7, 2026-10-07): `insuranceRenewalAlertJob.js`
 * alertava a renovação 30 dias antes do vencimento, mas nada agia quando a vigência acabava de
 * fato — a apólice ficava ACTIVE para sempre. Este job transiciona apólices ACTIVE/ISSUED cujo
 * `expiryDate` (último dia de cobertura, inclusive) já passou para EXPIRED — status já previsto
 * na migration 20260101000272. A trava "dura" de sinistro novo fica em
 * `insurance.service.js#openClaim` (checa a data, não só o status), então este job é a camada
 * de visibilidade/relatório; mesmo que ele atrase, nenhum sinistro novo passa numa apólice
 * vencida.
 *
 * Mesmo padrão de `insuranceRenewalAlertJob.js`: varredura por empresa com RLS via SET LOCAL,
 * re-busca com lock pessimista dentro de uma transação aninhada e reconfirma o status antes de
 * escrever (evita duplicidade em deploy multi-réplica).
 *
 * Idempotência: a transição é ACTIVE/ISSUED -> EXPIRED; uma apólice já EXPIRED não volta a ser
 * candidata, então a Notification/auditoria é gerada UMA vez por apólice.
 */
async function expireDuePolicies(transaction, now = new Date()) {
  const today = todayDateOnly(now);
  const candidates = await InsurancePolicy.findAll({
    where: {
      status: { [Op.in]: POLICY_STATUSES_ELIGIBLE_FOR_CLAIM },
      expiryDate: { [Op.lt]: today },
    },
    transaction,
  });

  let expired = 0;
  for (const candidate of candidates) {
    try {
      const didExpire = await sequelize.transaction({ transaction }, async (nested) => {
        const policy = await InsurancePolicy.findByPk(candidate.id, { transaction: nested, lock: nested.LOCK.UPDATE });
        if (!policy || !POLICY_STATUSES_ELIGIBLE_FOR_CLAIM.includes(policy.status)) return false;
        if (!policy.expiryDate || String(policy.expiryDate).slice(0, 10) >= today) return false;

        const beforeJson = policy.toJSON();
        policy.status = 'EXPIRED';
        await policy.save({ transaction: nested });

        if (policy.createdBy) {
          // GAP REAL CORRIGIDO (auditoria contrato "Alertas: criticidade, responsável, canal e
          // prazo de resposta", 2026-10-08): o corpo tinha item/data, mas nenhuma criticidade
          // explícita nem prazo de resposta — quem recebe não sabe se é urgente nem até quando
          // agir. `daysOverdue` (sempre >= 1, já que o job só roda em apólices com expiryDate no
          // passado) e o rótulo CRÍTICO deixam a gravidade e o prazo explícitos no texto.
          const daysOverdue = Math.max(
            1,
            Math.round((new Date(today).getTime() - new Date(policy.expiryDate).getTime()) / (24 * 60 * 60 * 1000))
          );
          await Notification.create(
            {
              groupId: policy.groupId,
              companyId: policy.companyId,
              userId: policy.createdBy,
              channel: 'IN_APP',
              title: 'Apólice de seguro vencida',
              body: `[CRÍTICO] A apólice ${policy.externalPolicyNumber || policy.id} teve a vigência encerrada em ${policy.expiryDate} (há ${daysOverdue} dia(s)) — novos sinistros estão bloqueados até a renovação. Prazo de resposta: imediato, renove ou substitua a apólice hoje.`,
            },
            { transaction: nested }
          );
        }

        await registrarAuditoria(
          {
            groupId: policy.groupId, companyId: policy.companyId, actorUserId: null,
            action: 'procurement.insurance_policy.expire',
            entityType: 'InsurancePolicy', entityId: policy.id,
            beforeJson, afterJson: policy.toJSON(),
            reason: `Vigência encerrada em ${policy.expiryDate} — apólice marcada como EXPIRED pelo job de vencimento.`,
          },
          nested
        );
        return true;
      });
      if (didExpire) expired += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[InsurancePolicyExpiryJob] Falha ao expirar apólice ${candidate.id}: ${err.message}`);
    }
  }

  return { policiesChecked: candidates.length, expired };
}

async function processCompany(group, company) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return expireDuePolicies(transaction);
  });
}

async function runInsurancePolicyExpiryJob() {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, policiesChecked: 0, expired: 0, errors: 0 };

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
        summary.policiesChecked += result.policiesChecked;
        summary.expired += result.expired;
      } catch (err) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[InsurancePolicyExpiryJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${err.message}`
        );
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[InsurancePolicyExpiryJob] Execução concluída — ${summary.groupsChecked} grupo(s), ${summary.companiesChecked} empresa(s), ` +
      `${summary.policiesChecked} apólice(s) verificada(s), ${summary.expired} expirada(s), ${summary.errors} erro(s).`
  );

  return summary;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hora — mesmo intervalo do alerta de renovação

function startInsurancePolicyExpiryJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  runInsurancePolicyExpiryJob().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[InsurancePolicyExpiryJob] Falha na execução inicial:', err.message);
  });

  return setInterval(() => {
    runInsurancePolicyExpiryJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[InsurancePolicyExpiryJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = {
  runInsurancePolicyExpiryJob,
  startInsurancePolicyExpiryJob,
  expireDuePolicies,
  processInsurancePolicyExpiryForCompany: processCompany,
};
