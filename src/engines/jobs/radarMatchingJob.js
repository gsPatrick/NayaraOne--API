'use strict';

const { sequelize, Group, Company, PropertyRadar, OutboxEvent, Notification } = require('../../models');
const { matchRadarToProperties } = require('../../features/radar/radarMatching.service');
const { publishRadarMatched } = require('../../features/radar/radarEvents.service');
const { registrarAuditoria } = require('../audit/auditLog.service');

/**
 * radarMatchingJob — antes, o matching do Radar só rodava sob demanda quando alguém abria a
 * tela (`GET /radar/:id/matches`), então um imóvel novo que batesse com o perfil de busca de
 * um cliente só era descoberto se alguém abrisse aquele radar específico por acaso. Este job
 * roda o matching periodicamente para TODOS os radares ativos e avisa (evento + notificação)
 * só quando encontra um match GENUÍNO NOVO — não fica reavisando do mesmo match a cada rodada.
 *
 * Sem `req`/RLS de sessão HTTP disponível (é um processo em background, não uma requisição),
 * então percorremos manualmente cada tenant abrindo a MESMA transação usada por
 * `SET LOCAL app.group_id/app.company_id` (mesmo mecanismo de tenant.middleware.js), nunca
 * lendo dado multiempresa fora desse contexto — preserva a regra fail-closed de RLS mesmo
 * para um processo de sistema.
 *
 * "core"."groups" é a única tabela sem RLS (raiz da hierarquia de tenant) — é o único ponto de
 * partida seguro para descobrir quais grupos/empresas existem.
 */

async function processCompany(group, company) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });

    const radars = await PropertyRadar.findAll({ where: { status: 'ACTIVE' }, transaction });

    let totalNewMatches = 0;

    for (const radar of radars) {
      const matches = await matchRadarToProperties(radar, transaction);
      if (matches.length === 0) continue;

      // Só considera "novo" o match cujo par (radar, imóvel) ainda não gerou o evento
      // radar.matched antes — a própria unicidade de `idempotency_key` no outbox já é a fonte
      // da verdade de "já avisamos isso", sem precisar de uma tabela de estado adicional.
      const alreadyNotified = await OutboxEvent.findAll({
        where: { aggregateType: 'PropertyRadar', aggregateId: radar.id, eventType: 'radar.matched' },
        attributes: ['idempotencyKey'],
        transaction,
      });
      const notifiedKeys = new Set(alreadyNotified.map((e) => e.idempotencyKey));

      const newMatches = matches.filter(
        (property) => !notifiedKeys.has(`radar.matched:${radar.id}:${property.id}`)
      );
      if (newMatches.length === 0) continue;

      for (const property of newMatches) {
        await publishRadarMatched(radar, property, transaction);
      }

      if (radar.createdBy) {
        await Notification.create(
          {
            groupId: radar.groupId,
            companyId: radar.companyId,
            userId: radar.createdBy,
            channel: 'IN_APP',
            title: 'Novo match no Radar',
            body: `Encontramos ${newMatches.length} imóve${newMatches.length === 1 ? 'l novo compatível' : 'is novos compatíveis'} com um radar de busca que você criou.`,
            createdBy: null,
            updatedBy: null,
          },
          { transaction }
        );
      }

      await registrarAuditoria(
        {
          groupId: radar.groupId,
          companyId: radar.companyId,
          actorUserId: null,
          action: 'radar.job_matched',
          entityType: 'PropertyRadar',
          entityId: radar.id,
          afterJson: { newMatchPropertyIds: newMatches.map((p) => p.id) },
          reason: `Job automático do Radar encontrou ${newMatches.length} novo(s) match(es) para este radar.`,
        },
        transaction
      );

      totalNewMatches += newMatches.length;
    }

    return { radarsChecked: radars.length, newMatches: totalNewMatches };
  });
}

async function runRadarMatchingJob() {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, radarsChecked: 0, newMatches: 0, errors: 0 };

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
        summary.radarsChecked += result.radarsChecked;
        summary.newMatches += result.newMatches;
      } catch (err) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[RadarMatchingJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${err.message}`
        );
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[RadarMatchingJob] Execução concluída — ${summary.groupsChecked} grupo(s), ${summary.companiesChecked} empresa(s), ` +
      `${summary.radarsChecked} radar(es) ativo(s) verificado(s), ${summary.newMatches} novo(s) match(es), ${summary.errors} erro(s).`
  );

  return summary;
}

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutos

/**
 * startRadarMatchingJob — agenda `runRadarMatchingJob` para rodar periodicamente. Roda uma
 * vez imediatamente ao iniciar o processo, depois repete no intervalo configurado. Retorna o
 * handle do `setInterval` (útil para `clearInterval` em testes).
 */
function startRadarMatchingJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  runRadarMatchingJob().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[RadarMatchingJob] Falha na execução inicial:', err.message);
  });

  return setInterval(() => {
    runRadarMatchingJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[RadarMatchingJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = { runRadarMatchingJob, startRadarMatchingJob };
