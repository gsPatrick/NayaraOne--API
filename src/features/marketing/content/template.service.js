'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const repo = require('./template.repository');
const { computeTemplateContentHash } = require('./template.hash');
const { parseCreateInput, parseListFilters, isUuid } = require('./template.validation');
const { readPageLimits } = require('../marketing.pagination');
const { assertLogoMatchesFile } = require('./template.brandTokens');
const { assertNoUnknownVariables } = require('./template.variables');
const { readOfficialChannels } = require('./template.settings');
const security = require('../security');
const { templateNotFound, templateVersionOutdated, officialRefRequired } = require('./template.errors');

const ENTITY = 'marketing.template';
const summary = (dto) => ({ code: dto.code, versionNo: dto.versionNo, status: dto.status, kind: dto.kind, channel: dto.channel, contentHash: dto.contentHash });

/**
 * Cria a versão 1 de um código novo ou a versão N+1 (sempre em DRAFT) de um código existente. A versão publicada nunca é
 * alterada (MKT-010): mudar um template é criar a próxima versão. A numeração é sequencial e serializada por código.
 */
async function createTemplate(tenant, actorUserId, input, transaction) {
  const codeProbe = input && typeof input.code === 'string' ? input.code.trim() : '';
  const inherited = codeProbe ? await repo.latestVersion(codeProbe, transaction) : null;
  const data = parseCreateInput(input, inherited);
  await security.assertUrlsAllowed(data.body, { tenant, transaction }); // M9-D433: a mesma regra de URL externa do link rastreável
  await assertLogoMatchesFile(data.brandTokens, transaction);
  await repo.lockCode(tenant.companyId, data.code, transaction);
  const latest = await repo.latestVersion(data.code, transaction);
  const versionNo = latest ? latest.version_no + 1 : 1;
  const contentHash = computeTemplateContentHash({ ...data, versionNo });
  const row = await repo.insertTemplate({
    groupId: tenant.groupId, companyId: tenant.companyId, ...data, versionNo, contentHash, actor: actorUserId || null,
  }, transaction);
  const dto = repo.toDto(row);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'marketing.template.create', entityType: ENTITY,
    entityId: dto.id, beforeJson: null, afterJson: summary(dto), reason: `Template ${dto.code} versão ${dto.versionNo} criado em rascunho.`,
  }, transaction);
  return dto;
}

function assertOfficialReference(row, officialChannels) {
  if (row.channel && officialChannels.includes(row.channel) && !row.official_template_ref) {
    throw officialRefRequired({ channel: row.channel });
  }
}

/**
 * Publica a versão: DRAFT -> PUBLISHED e aposenta a PUBLISHED anterior do mesmo código (só para uso novo). Idempotente: publicar
 * de novo a versão já publicada devolve replay=true sem efeito. Serializa por código e trava a linha com FOR UPDATE.
 */
async function publishTemplate(tenant, actorUserId, templateId, transaction) {
  if (!isUuid(templateId)) throw templateNotFound();
  const probe = await repo.findById(templateId, transaction);
  if (!probe) throw templateNotFound();
  await repo.lockCode(tenant.companyId, probe.code, transaction);
  const row = await repo.lockById(templateId, transaction);
  if (!row) throw templateNotFound();
  if (row.status === 'PUBLISHED') return { template: repo.toDto(row), replay: true, retiredVersionNo: null };
  const highest = await repo.highestReleasedVersion(row.code, transaction);
  // Versão aposentada só existe porque uma maior foi publicada: publicá-la é sempre "versão desatualizada", qualquer que seja a ordem da corrida.
  if (row.status === 'RETIRED') throw templateVersionOutdated({ versionNo: row.version_no, highestVersionNo: highest, status: row.status });
  if (highest !== null && highest > row.version_no) throw templateVersionOutdated({ versionNo: row.version_no, highestVersionNo: highest });
  assertNoUnknownVariables(row.body, row.variables_json);
  assertOfficialReference(row, await readOfficialChannels(tenant, transaction));

  const retired = await repo.retireOtherPublished(row.code, row.id, actorUserId || null, transaction);
  const published = repo.toDto(await repo.markPublished(row.id, actorUserId || null, transaction));
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'marketing.template.publish', entityType: ENTITY,
    entityId: published.id, beforeJson: summary({ ...published, status: row.status }), afterJson: { ...summary(published), retiredVersions: retired },
    reason: `Template ${published.code} versão ${published.versionNo} publicado.`,
  }, transaction);
  return { template: published, replay: false, retiredVersionNo: retired.length > 0 ? Math.max(...retired) : null };
}

/** Lista por código, com o histórico de versões (mais nova primeiro) e a versão vigente (PUBLISHED). Paginada por código. */
async function listTemplates(tenant, rawFilters, transaction) {
  const filters = parseListFilters(rawFilters, await readPageLimits(tenant, transaction)); // M9-D435: mesma paginação das publicações (parâmetros da empresa)
  const total = await repo.countCodes(filters, transaction);
  const codes = await repo.pageOfCodes(filters, filters.pageSize, (filters.page - 1) * filters.pageSize, transaction);
  const versions = await repo.versionsOfCodes(codes, filters, transaction);
  const published = await repo.publishedOfCodes(codes, transaction);
  const items = codes.map((code) => {
    const list = versions.filter((v) => v.code === code).map(repo.toDto);
    const current = published.find((p) => p.code === code);
    return { code, kind: list[0].kind, channel: list[0].channel, currentPublished: current ? repo.toDto(current) : null, versions: list };
  });
  return { items, total, page: filters.page, pageSize: filters.pageSize };
}

module.exports = { createTemplate, publishTemplate, listTemplates };
