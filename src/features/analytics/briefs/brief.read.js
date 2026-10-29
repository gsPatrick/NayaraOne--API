'use strict';

/**
 * M9-D693 (3.2 a, 6) — exibição do briefing vigente para um LEITOR. O briefing gravado é único por empresa, tipo e período e não depende de
 * quem lê; ao EXIBIR, o servidor tira os itens cujo domínio o leitor não pode ver (sem mudar o gravado e sem dizer que algo foi tirado).
 * Exige `analytics:brief:read`. A leitura passa por prepareSecureRows (mascaramento de RESTRICTED) e grava BRIEF_READ no log de acesso.
 * Briefing não gerado (FAILED ou BLOCKED_GROUNDING) ou ainda inexistente aparece como "Briefing indisponível": nenhum texto é inventado.
 */
const readStore = require('../briefReadStore.service');
const { P, assertPermission, prepareSecureRows, has, loadDomainMap, domainPermissionOf } = require('../security');

const UNAVAILABLE_TEXT = 'Briefing indisponível';

const visibleTo = (ctx, map) => (item) => (Array.isArray(item.dominios) ? item.dominios : []).every((d) => has(ctx, domainPermissionOf(map, d)));
const day = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

/** ctx: { groupId, companyId, actorUserId, permissions }. null se a empresa nunca teve briefing do tipo. */
async function getBriefForReader(ctx, { briefType, periodStart = null, periodEnd = null, ip = null, route = null }, transaction) {
  assertPermission(ctx, P.BRIEF_READ);
  const brief = await readStore.findCurrentBrief({ companyId: ctx.companyId, groupId: ctx.groupId, briefType, periodStart, periodEnd }, transaction);
  if (!brief) return null;
  const view = { id: brief.id, briefType, periodStart: day(brief.periodStart), periodEnd: day(brief.periodEnd), generatedAt: brief.generatedAt, status: brief.status };
  if (brief.status !== 'GENERATED') {
    await prepareSecureRows(ctx, { permission: P.BRIEF_READ, action: 'BRIEF_READ', resourceType: 'BRIEF', resourceCode: `${briefType}:${view.periodEnd}`, route, filters: { briefType }, rows: [], ip, transaction });
    return { ...view, available: false, message: UNAVAILABLE_TEXT, items: [], closing: null };
  }
  const content = brief.content && !Array.isArray(brief.content) ? brief.content : { itens: brief.content || [] };
  const map = await loadDomainMap(ctx, transaction);
  const items = (content.itens || []).filter(visibleTo(ctx, map));
  const secured = await prepareSecureRows(ctx, {
    permission: P.BRIEF_READ, action: 'BRIEF_READ', resourceType: 'BRIEF', resourceCode: `${briefType}:${view.periodEnd}`, route,
    filters: { briefType, periodStart: view.periodStart, periodEnd: view.periodEnd }, rows: items, ip, transaction,
  });
  return { ...view, available: true, items: secured.rows, closing: content.fechamento || null, freshnessSummary: brief.freshnessSummary, qualitySummary: brief.qualitySummary };
}

module.exports = { getBriefForReader, UNAVAILABLE_TEXT };
