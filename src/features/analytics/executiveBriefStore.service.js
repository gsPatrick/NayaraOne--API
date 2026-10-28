'use strict';

/**
 * M9-D601 — armazenamento dos briefings executivos da NAY Diretoria (analytics.executive_briefs).
 *
 * Regras do livro: fontes obrigatórias (source_refs não vazio, em QUALQUER status: o worker registra as
 * fontes que tentou usar também no FAILED/BLOCKED_GROUNDING); uma versão vigente por
 * (empresa/grupo, tipo, período); regenerar torna a anterior SUPERSEDED (única alteração permitida
 * depois de gravado). O fluxo de geração (agenda, IA, grounding) é da M9-D693/D694. Escrita só do worker.
 */

const { sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { run, invalid, requireOneOf, isPlainObject, assertWriter, MSG } = require('./analyticsStoreSupport');

const CODE = 'ANALYTICS_BRIEF_INVALID';
const BRIEF_TYPES = ['DAILY', 'WEEKLY'];
const CREATE_STATUSES = ['GENERATED', 'BLOCKED_GROUNDING', 'FAILED'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireDate(value, label) {
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw invalid(CODE, `${label} deve ser uma data no formato AAAA-MM-DD.`);
  }
}

function validateBrief(input) {
  if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length === 0) {
    throw AppError.unprocessable(MSG.BRIEF_NO_SOURCES, 'ANALYTICS_BRIEF_NO_SOURCES');
  }
  requireOneOf(input.briefType, BRIEF_TYPES, 'Tipo de briefing', CODE);
  requireOneOf(input.status || 'GENERATED', CREATE_STATUSES, 'Status do briefing', CODE);
  if (!input.groupId) throw invalid(CODE, 'Informe o grupo.');
  requireDate(input.periodStart, 'O início do período');
  requireDate(input.periodEnd, 'O fim do período');
  if (input.periodEnd < input.periodStart) throw invalid(CODE, 'O fim do período não pode ser anterior ao início.');
  const content = input.content === undefined ? [] : input.content;
  if (!Array.isArray(content) && !isPlainObject(content)) throw invalid(CODE, 'O conteúdo do briefing deve ser uma lista ou um objeto.');
  for (const key of ['freshnessSummary', 'qualitySummary']) {
    if (input[key] !== undefined && !isPlainObject(input[key])) throw invalid(CODE, 'Os resumos de frescor e qualidade devem ser objetos.');
  }
  if (['BLOCKED_GROUNDING', 'FAILED'].includes(input.status) && !(typeof input.blockedReason === 'string' && input.blockedReason.trim())) {
    throw invalid(CODE, 'Briefing bloqueado ou falho exige o motivo (blockedReason).');
  }
  return content;
}

/** Grava o briefing. Com `supersede: true`, a versão vigente do mesmo período vira SUPERSEDED na mesma transação. */
async function createExecutiveBrief(input, ctx, transaction) {
  await assertWriter(transaction);
  const content = validateBrief(input);
  return run(async () => {
    const keyReplacements = {
      companyId: input.companyId || null, groupId: input.groupId, briefType: input.briefType,
      periodStart: input.periodStart, periodEnd: input.periodEnd,
    };
    if (input.supersede === true) {
      await sequelize.query(
        `UPDATE analytics.executive_briefs SET status = 'SUPERSEDED', updated_at = now()
          WHERE company_id IS NOT DISTINCT FROM :companyId AND group_id = :groupId AND brief_type = :briefType
            AND period_start = :periodStart AND period_end = :periodEnd AND status <> 'SUPERSEDED'`,
        { replacements: keyReplacements, transaction }
      );
    }
    const [[row]] = await sequelize.query(
      `INSERT INTO analytics.executive_briefs
         (company_id, group_id, brief_type, period_start, period_end, generated_at, ai_run_id, status, content, source_refs,
          freshness_summary, quality_summary, blocked_reason)
       VALUES (:companyId, :groupId, :briefType, :periodStart, :periodEnd, COALESCE(:generatedAt, now()), :aiRunId, :status,
          CAST(:content AS jsonb), CAST(:sourceRefs AS jsonb), CAST(:freshness AS jsonb), CAST(:quality AS jsonb), :blockedReason)
       RETURNING *`,
      {
        replacements: {
          ...keyReplacements, generatedAt: input.generatedAt || null, aiRunId: input.aiRunId || null, status: input.status || 'GENERATED',
          content: JSON.stringify(content), sourceRefs: JSON.stringify(input.sourceRefs),
          freshness: JSON.stringify(input.freshnessSummary || {}), quality: JSON.stringify(input.qualitySummary || {}),
          blockedReason: input.blockedReason || null,
        },
        transaction,
      }
    );
    return row;
  });
}

/** Briefing vigente (não SUPERSEDED) de um período; null quando não há. */
async function getCurrentBrief({ companyId = null, groupId, briefType, periodStart, periodEnd }, transaction) {
  const [rows] = await sequelize.query(
    `SELECT * FROM analytics.executive_briefs
      WHERE company_id IS NOT DISTINCT FROM :companyId AND group_id = :groupId AND brief_type = :briefType
        AND period_start = :periodStart AND period_end = :periodEnd AND status <> 'SUPERSEDED'`,
    { replacements: { companyId, groupId, briefType, periodStart, periodEnd }, transaction }
  );
  return rows[0] || null;
}

module.exports = { createExecutiveBrief, getCurrentBrief };
