'use strict';

const { Op } = require('sequelize');
const { sequelize, Group, Company, Project, Notification } = require('../../models');
const { publishProjectDelayDetected } = require('../../features/construction/constructionEvents.service');

/**
 * projectDelayDetectionJob (M6-74, corrigido em 30/09/2026 — auditoria pós-merge encontrou a
 * ausência total) — varre obras com `endsAtPlanned` no passado que ainda não chegaram a um
 * status terminal (DELIVERED/CANCELLED) e publica `project.delay.detected`. Mesmo padrão de
 * `warrantyEscalationJob.js` (varredura por grupo/empresa com SET LOCAL, uma transação por
 * empresa).
 *
 * Idempotência: a `idempotencyKey` do evento inclui a data corrente (YYYY-MM-DD) — o outbox
 * deduplica reprocessamentos no MESMO dia (rodar o job várias vezes seguidas não duplica o
 * evento), mas o dia seguinte gera um novo evento de lembrete enquanto a obra continuar
 * atrasada — comportamento desejado para escalonamento, não um bug de duplicação.
 */

// M6-18: uma obra que já saiu de execução (FINAL_INSPECTION em diante) não é mais candidata a
// "atraso de cronograma" — o atraso só faz sentido enquanto a obra ainda está sendo construída.
const TERMINAL_STATUSES = ['FINAL_INSPECTION', 'DELIVERED', 'WARRANTY', 'CLOSED', 'CANCELLED'];

function todayKey(now) {
  return now.toISOString().slice(0, 10);
}

async function detectDelayedProjects(transaction, now = new Date()) {
  const candidates = await Project.findAll({
    where: {
      endsAtPlanned: { [Op.ne]: null, [Op.lt]: now },
      status: { [Op.notIn]: TERMINAL_STATUSES },
    },
    transaction,
  });

  let detected = 0;
  let notified = 0;
  for (const project of candidates) {
    try {
      // BUG REAL CORRIGIDO (rodada 15, estendido no Ciclo 20 — "ciclos até secar", 09/10/2026):
      // o evento (publishProjectDelayDetected) já estava isolado em savepoint, mas o bloco de
      // notificação abaixo rodava direto na transação EXTERNA (sem savepoint próprio). Se o
      // Notification.create de uma obra falhasse por qualquer erro não tratado via savepoint,
      // o Postgres abortava a transação inteira da empresa — desfazendo (rollback) os eventos
      // já publicados via savepoint das obras ANTERIORES do mesmo lote, mesmo esses tendo
      // comitado com sucesso dentro de seus próprios savepoints (savepoint comitado ainda fica
      // sob o guarda-chuva da transação externa). Agora evento + notificação da MESMA obra
      // compartilham um único savepoint — falha em qualquer parte do processamento de UMA obra
      // nunca aborta o trabalho já feito pelas obras anteriores do mesmo lote.
      let projectNotified = false;
      await sequelize.transaction({ transaction }, async (nested) => {
        await publishProjectDelayDetected(project, todayKey(now), nested);

        // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 15, 2026-10-05): o evento
        // project.delay.detected só ia pro outbox (integração externa) — ninguém DENTRO do app
        // era avisado. Mesma lacuna já corrigida em R7/R9/R10 pra outros jobs. Como este evento
        // se repete todo dia enquanto a obra continuar atrasada (de propósito, pra
        // escalonamento), a notificação também é por dia — uma checagem simples evita duplicar
        // se o job rodar mais de uma vez no mesmo dia.
        if (project.responsibleUserId) {
          const title = 'Obra atrasada';
          // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 44, 2026-10-05): dedupe
          // check-then-create sem lock — em deploy multi-réplica, dois processos podiam ambos
          // ler "ainda não notificado hoje" antes de qualquer INSERT comitar.
          // pg_advisory_xact_lock serializa por projeto+dia (liberado automaticamente no fim da
          // transação/savepoint).
          await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
            replacements: { key: `project-delay-notify:${project.id}:${todayKey(now)}` },
            transaction: nested,
          });
          const alreadyNotifiedToday = await Notification.findOne({
            where: { userId: project.responsibleUserId, title },
            order: [['created_at', 'DESC']],
            transaction: nested,
          });
          const sameDay = alreadyNotifiedToday && todayKey(new Date(alreadyNotifiedToday.created_at)) === todayKey(now);
          if (!sameDay) {
            await Notification.create(
              {
                groupId: project.groupId,
                companyId: project.companyId,
                userId: project.responsibleUserId,
                channel: 'IN_APP',
                title,
                body: `A obra ${project.name || project.id} está atrasada (previsão: ${project.endsAtPlanned}) — verifique o cronograma.`,
              },
              { transaction: nested }
            );
            projectNotified = true;
          }
        }
      });
      detected += 1;
      if (projectNotified) notified += 1;
    } catch (err) {
      // BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 20, Frente A, 09/10/2026): o catch só
      // absorvia SequelizeUniqueConstraintError (reenvio no mesmo dia) e relançava qualquer
      // outro erro — isso abortava o loop inteiro (e, por propagação, a transação da empresa
      // em processCompany), impedindo o processamento dos demais projetos do mesmo lote por
      // causa de UM projeto com problema. Mesmo padrão dos jobs irmãos (warrantyEscalationJob.js/
      // missingDailyReportJob.js): loga e segue para o próximo projeto, nunca aborta o lote.
      if (err?.name !== 'SequelizeUniqueConstraintError') {
        // eslint-disable-next-line no-console
        console.error(`[ProjectDelayDetectionJob] Falha ao processar obra ${project.id}: ${err.message}`);
      }
    }
  }

  return { projectsChecked: candidates.length, detected, notified };
}

async function processCompany(group, company) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return detectDelayedProjects(transaction);
  });
}

async function runProjectDelayDetectionJob() {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, projectsChecked: 0, detected: 0, notified: 0, errors: 0 };

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
        summary.projectsChecked += result.projectsChecked;
        summary.detected += result.detected;
        summary.notified += result.notified;
      } catch (err) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[ProjectDelayDetectionJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${err.message}`
        );
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[ProjectDelayDetectionJob] Execução concluída — ${summary.groupsChecked} grupo(s), ${summary.companiesChecked} empresa(s), ` +
      `${summary.projectsChecked} obra(s) verificada(s), ${summary.detected} evento(s) publicado(s), ${summary.errors} erro(s).`
  );

  return summary;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hora

function startProjectDelayDetectionJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  runProjectDelayDetectionJob().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[ProjectDelayDetectionJob] Falha na execução inicial:', err.message);
  });

  return setInterval(() => {
    runProjectDelayDetectionJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[ProjectDelayDetectionJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = {
  runProjectDelayDetectionJob,
  startProjectDelayDetectionJob,
  detectDelayedProjects,
  processProjectDelayDetectionForCompany: processCompany,
};
