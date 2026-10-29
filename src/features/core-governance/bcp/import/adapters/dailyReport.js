'use strict';

const { DailyReport } = require('../../../../../models');
const { createDailyReport } = require('../../../../construction/dailyReports.service');
const { resolveRef } = require('../refs');
const { commandRejected } = require('../../bcp.errors');
const normalize = require('../normalize');

/** Chave de idempotência do serviço de obras: `bcp:<empresa>:<número>` (DI-D832-3). */
const keyOf = (tenant, reference) => `bcp:${tenant.companyId}:${reference}`;
/** Primeiro número inteiro da equipe escrita no papel ("5 pessoas" = 5), ou null. */
const headcountOf = (text) => { const m = /\d+/.exec(String(text || '')); return m ? Number(m[0]) : null; };

/**
 * DAILY_REPORT: o diário de obra do papel vira RDO pelo serviço normal de Obras (turno único, equipe lida do texto, o papel digitalizado como evidência). Confere obra e data.
 * O RDO é só de acréscimo no serviço normal, então a divergência desta ação só pode ser aceita (reverse recusa).
 */
async function execute({ tenant, actorUserId, operation, payload, transaction }) {
  const project = await resolveRef('project', payload.obra, tenant, transaction);
  if (!normalize.day(payload.data)) throw commandRejected('a data do diário é inválida');
  const notes = [payload.ocorrencias, `Equipe presente: ${payload.equipePresente}.`, `Fotos: ${payload.fotosQuantidade}.`, `Origem BCP ${operation.manualReference}.`].filter(Boolean).join(' ');
  const report = await createDailyReport(project.id, {
    groupId: tenant.groupId, companyId: tenant.companyId, reportDate: payload.data, weather: payload.clima || null, workforceCount: headcountOf(payload.equipePresente), occurrences: notes,
    servicesPerformed: payload.servicosExecutados, evidenceFileIds: [operation.evidenceFileId], idempotencyKey: keyOf(tenant, operation.manualReference),
  }, actorUserId, transaction);
  const saved = await DailyReport.findByPk(report.id, { transaction });
  return {
    commandRef: `DailyReport:${saved.id}`,
    undo: { dailyReportId: saved.id },
    comparisons: [
      { field: 'obra', label: 'Obra', paper: normalize.id(project.id), command: normalize.id(saved.projectId), kind: 'ref' },
      { field: 'data', label: 'Data do diário', paper: normalize.day(payload.data), command: normalize.day(saved.reportDate), kind: 'date' },
    ],
  };
}

async function reverse() {
  throw commandRejected('o diário de obra é um registro só de acréscimo no serviço de Obras e não tem estorno; aceite a divergência ou corrija o diário pelo próprio módulo de Obras');
}

module.exports = { action: 'DAILY_REPORT', execute, reverse };
