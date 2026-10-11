'use strict';

const { Opportunity } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { listOpportunities } = require('./opportunity.service');
const { assertRecentMfa } = require('../users/mfa.service');

/**
 * M3-21 — Exportação sensível LIMITADA e AUDITADA.
 *
 * Três garantias, todas obrigatórias:
 *
 * (a) PERMISSÃO DEDICADA — `crm:opportunities:export` (criada em
 *     migrations/20260101000125-seed-crm-marco3-permissions.js, risk_level HIGH). Quem pode
 *     VER a lista na tela (`crm:opportunities:read`) NÃO ganha automaticamente o direito de
 *     BAIXAR a base inteira: ler 20 linhas na tela e levar 20 mil num CSV são riscos
 *     diferentes. A rota já monta `requirePermission('crm:opportunities:export')`, e este
 *     service RECHECA a permissão (defesa em profundidade / fail closed): mesmo que alguém
 *     chame a função por outro caminho — um job, um script, uma rota futura montada errada —
 *     sem a permissão o caminho morre aqui com 403.
 *
 * (b) AUDITORIA SEMPRE — toda exportação bem-sucedida grava `data.export` em
 *     "audit"."audit_log" com QUEM exportou, QUANTOS registros saíram, o formato e os
 *     filtros aplicados. A auditoria é gravada na MESMA transação da leitura, antes de
 *     devolver o conteúdo: não existe caminho "exportou e não logou".
 *
 * (c) CAMPOS LIMITADOS — a exportação NÃO devolve a linha crua do banco. Só as colunas de
 *     EXPORT_FIELDS abaixo saem.
 *
 * (d) MFA RECENTE + LIMITE DE VOLUME (CRM-TS-013 / item 14 do Caderno, seção 18 — pendência
 *     fechada nesta rodada, "nenhum parcial"): exportação em massa é uma ação de risco igual
 *     à liquidação financeira que já exige step-up MFA (Marco 4 — ver
 *     src/features/finance/approvals.service.js, mesmo `assertRecentMfa`). Reutiliza o MESMO
 *     mecanismo de MFA, não um novo — usuário sem MFA habilitado ou sem verificação recente
 *     (janela configurável em mfa.service.js) é bloqueado ANTES de ler qualquer linha.
 *     Limite de volume: MAX_EXPORT_RECORDS (abaixo) — acima disso, a exportação é recusada
 *     com erro claro pedindo para filtrar (stage/personId/propertyId), em vez de silenciosamente
 *     truncar o resultado (truncar sem avisar seria pior: dado incompleto parecendo completo).
 *
 *     DECISÃO DOCUMENTADA sobre quais campos entram e por quê:
 *       - id, stage, temperature, expectedValue, closedAt, createdAt, nextActionDueAt:
 *         operacionais, necessários para qualquer análise de funil fora do sistema.
 *       - wonReason/lostReason/withdrawnReason: motivos ESTRUTURADOS (enum do M3-12) —
 *         valores canônicos, não texto livre, logo sem risco de vazar relato pessoal.
 *       - personId / propertyId / ownerUserId: apenas os IDENTIFICADORES OPACOS (UUID). O
 *         CSV permite religar com a base interna, mas sozinho não revela ninguém.
 *     O que fica DE FORA de propósito: `nextAction` (texto livre digitado pelo corretor,
 *     costuma conter dado pessoal e comentário interno sobre o cliente) e qualquer JOIN com
 *     "people"."persons" — nome, CPF/CNPJ, contato e endereço NÃO saem por esta rota. Quem
 *     precisa de dado cadastral de pessoa precisa de uma exportação própria, com a sua
 *     própria permissão e a sua própria decisão de minimização.
 */

const EXPORT_PERMISSION = 'crm:opportunities:export';

const EXPORT_FIELDS = [
  'id',
  'stage',
  'temperature',
  'expectedValue',
  'wonReason',
  'lostReason',
  'withdrawnReason',
  'closedAt',
  'nextActionDueAt',
  'personId',
  'propertyId',
  'ownerUserId',
  'createdAt',
];

const FORMATS = ['csv', 'json'];

// CRM-TS-013 / item 14 (Caderno, seção 18): teto razoável por exportação. Não é um valor do
// Caderno (que não define número) — 5000 é uma ordem de grandeza conservadora para exportação
// manual via CSV/JSON síncrono (acima disso, o caminho correto é um job assíncrono dedicado,
// fora de escopo desta correção). Acima do limite, a exportação é recusada (não truncada).
const MAX_EXPORT_RECORDS = 5000;

function assertExportPermission(permissions) {
  const granted = Array.isArray(permissions) ? permissions : [];
  if (!granted.includes(EXPORT_PERMISSION)) {
    throw AppError.forbidden(
      `Permissão ausente: ${EXPORT_PERMISSION}.`,
      'PERMISSION_DENIED',
      { required: EXPORT_PERMISSION }
    );
  }
}

function toExportRow(opportunity) {
  const json = opportunity.toJSON ? opportunity.toJSON() : opportunity;
  const row = {};
  for (const field of EXPORT_FIELDS) {
    const value = json[field];
    row[field] = value instanceof Date ? value.toISOString() : value === undefined ? null : value;
  }
  return row;
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Prefixo defensivo contra CSV injection (fórmula executada ao abrir no Excel/Sheets).
  const safe = /^[=+\-@]/.test(str) ? `'${str}` : str;
  return `"${safe.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows) {
  const header = EXPORT_FIELDS.join(',');
  const body = rows.map((row) => EXPORT_FIELDS.map((field) => escapeCsvValue(row[field])).join(','));
  return [header, ...body].join('\n');
}

/**
 * exportOpportunities — lê pela MESMA função de listagem usada por GET /crm/opportunities
 * (listOpportunities), então a exportação nunca mostra um recorte diferente do que a tela
 * mostra (mesmos filtros, mesmo RLS, mesmo soft-delete).
 *
 * Retorna `{ format, contentType, filename, recordCount, content, rows }`.
 */
async function exportOpportunities(
  { groupId, companyId, actorUserId, actorPermissions, format, filters },
  transaction
) {
  assertExportPermission(actorPermissions);
  await assertRecentMfa(actorUserId, transaction);

  const normalizedFormat = String(format || 'csv').toLowerCase();
  if (!FORMATS.includes(normalizedFormat)) {
    throw AppError.badRequest(`O campo "format" deve ser um de: ${FORMATS.join(', ')}.`, 'EXPORT_VALIDATION');
  }

  const appliedFilters = {
    stage: (filters && filters.stage) || undefined,
    personId: (filters && filters.personId) || undefined,
    propertyId: (filters && filters.propertyId) || undefined,
  };

  const opportunities = await listOpportunities(transaction, appliedFilters);
  if (opportunities.length > MAX_EXPORT_RECORDS) {
    throw AppError.badRequest(
      `A exportação tem ${opportunities.length} registros, acima do limite de ${MAX_EXPORT_RECORDS} por exportação. Filtre por "stage", "personId" ou "propertyId" e tente novamente.`,
      'EXPORT_VOLUME_LIMIT_EXCEEDED'
    );
  }
  const rows = opportunities.map(toExportRow);
  const recordCount = rows.length;

  const content = normalizedFormat === 'csv' ? rowsToCsv(rows) : JSON.stringify(rows);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'data.export',
      entityType: 'Opportunity',
      entityId: null,
      afterJson: {
        exportType: 'crm.opportunities',
        format: normalizedFormat,
        recordCount,
        fields: EXPORT_FIELDS,
        filters: appliedFilters,
      },
      reason: `Exportação sensível de ${recordCount} oportunidade(s) em ${normalizedFormat.toUpperCase()}.`,
    },
    transaction
  );

  return {
    format: normalizedFormat,
    contentType: normalizedFormat === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
    filename: `oportunidades-${new Date().toISOString().slice(0, 10)}.${normalizedFormat}`,
    recordCount,
    content,
    rows,
  };
}

module.exports = {
  EXPORT_PERMISSION,
  EXPORT_FIELDS,
  FORMATS,
  MAX_EXPORT_RECORDS,
  assertExportPermission,
  exportOpportunities,
};
