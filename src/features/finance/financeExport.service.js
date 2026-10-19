'use strict';

const { FinancialEntry } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

/**
 * Exportação financeira (Caderno Marco 4 §17, Antifraude: "Exportação financeira massiva →
 * MFA + auditoria + limite").
 *
 *   - MFA: a rota exige step-up recente (requireRecentMfa), além de finance:read;
 *   - limite: no máximo EXPORT_MAX_ROWS linhas por exportação. Se o filtro devolver mais, a
 *     exportação é RECUSADA inteira (FINANCE_EXPORT_LIMIT_EXCEEDED) — nunca um arquivo truncado
 *     em silêncio; o usuário precisa estreitar o filtro (competência, natureza, status);
 *   - auditoria: cada exportação grava audit_log com filtros, quantidade e hash do conteúdo.
 * Somente leitura: não altera nenhum lançamento.
 */
const EXPORT_MAX_ROWS = 5000;
const COLUMNS = ['id', 'competenceMonth', 'nature', 'entryType', 'status', 'amount', 'dueAt', 'settledAt', 'description', 'isThirdPartyFunds'];

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",;\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function exportFinancialEntries(ctx, filters, transaction, options = {}) {
  const maxRows = Number(options.maxRows) > 0 ? Number(options.maxRows) : EXPORT_MAX_ROWS;
  const where = {};
  if (filters.competenceMonth) {
    if (!/^\d{4}-\d{2}$/.test(String(filters.competenceMonth))) {
      throw AppError.badRequest('Competência inválida (use AAAA-MM).', 'FINANCE_EXPORT_VALIDATION');
    }
    where.competenceMonth = String(filters.competenceMonth);
  }
  if (filters.nature) where.nature = String(filters.nature).toUpperCase();
  if (filters.status) where.status = String(filters.status).toUpperCase();

  const total = await FinancialEntry.count({ where, transaction });
  if (total > maxRows) {
    throw AppError.badRequest(
      `A exportação teria ${total} lançamentos, acima do limite de ${maxRows}. Filtre por competência, natureza ou status.`,
      'FINANCE_EXPORT_LIMIT_EXCEEDED',
      { total, limit: maxRows }
    );
  }

  const rows = await FinancialEntry.findAll({ where, order: [['due_at', 'ASC'], ['id', 'ASC']], transaction });
  const lines = [COLUMNS.join(';')];
  for (const row of rows) lines.push(COLUMNS.map((c) => csvCell(row.get(c))).join(';'));
  const csv = `${lines.join('\n')}\n`;
  const sha256 = require('crypto').createHash('sha256').update(csv).digest('hex'); // eslint-disable-line global-require

  await registrarAuditoria(
    {
      groupId: ctx.groupId,
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'finance.entries.export',
      entityType: 'FinancialEntryExport',
      entityId: null,
      afterJson: { filters: where, rows: rows.length, limit: maxRows, sha256 },
      reason: `Exportação financeira de ${rows.length} lançamento(s) (limite ${maxRows}, MFA recente).`,
    },
    transaction
  );

  return { csv, rows: rows.length, sha256, limit: maxRows };
}

module.exports = { exportFinancialEntries, EXPORT_MAX_ROWS };
