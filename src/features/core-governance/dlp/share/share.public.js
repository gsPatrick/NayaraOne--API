'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { isModuleEnabled } = require('../../governance.module');
const { sequelize } = require('../../../../models');
const { withOwnTenantTransaction } = require('../guard.tx');
const exportSettings = require('../exports/export.settings');
const settings = require('./share.settings');
const errors = require('./share.errors');
const repo = require('./share.repository');
const { getResource } = require('./share.catalog');
const { hashToken, looksLikeToken } = require('./share.token');
const { maskForAnonymous } = require('./share.mask');
const limiter = require('./share.ratelimit');

const stamp = (date) => date.toISOString().slice(0, 16).replace('T', ' ');

/** Resolve a empresa pelo hash do token, numa transação curta (sem empresa na sessão: só a política de leitura por hash enxerga a linha). */
const resolveRoute = (tokenHash) => sequelize.transaction((transaction) => repo.resolveByHash(tokenHash, transaction));

function watermarkTemplate(link, template, now) {
  return String(template).replace(/\{(destinatario|data|link)\}/g, (_m, name) => ({ destinatario: link.recipientLabel, data: stamp(now), link: link.id }[name]));
}

/** Acrescenta a linha final da marca ao texto/CSV entregue (os demais tipos nunca chegam aqui com marca: a criação os recusa). */
const stampFile = (file, line) => ({ ...file, buffer: Buffer.concat([file.buffer, Buffer.from(`${file.buffer.length && file.buffer[file.buffer.length - 1] !== 10 ? '\n' : ''}${line}\n`, 'utf8')]) });

async function openLink(tenant, route, now) {
  return withOwnTenantTransaction(tenant, null, async (transaction) => {
    const link = await repo.findActiveForAccess(tenant.companyId, route.id, transaction);
    if (!link || !(await isModuleEnabled('dlp', tenant, transaction))) return null;
    const resource = getResource(link.resourceType);
    const loaded = resource ? await resource.load({ groupId: tenant.groupId, companyId: tenant.companyId }, link.resourceId, transaction) : null;
    if (!loaded) return null;
    const read = (key) => getSetting(key, tenant, transaction, exportSettings.EXPORT_SETTING_DEFAULTS[key] || settings.SHARE_SETTING_DEFAULTS[key]);
    const maskText = exportSettings.textOr(await read(exportSettings.MASK_KEY), exportSettings.MASK_KEY);
    const mark = link.watermark ? watermarkTemplate(link, settings.markTemplate(await read(settings.FILE_MARK_KEY)), now) : null;
    await repo.recordAccess(tenant.companyId, link.id, transaction);
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'dlp.share.accessed', entityType: 'ShareLink', entityId: link.id, beforeJson: null,
      afterJson: { resourceType: link.resourceType, resourceId: link.resourceId, accessedAt: now.toISOString(), accessCount: link.accessCount + 1 }, reason: `Link externo de ${link.resourceType} aberto.`,
    }, transaction);
    return { link, data: maskForAnonymous(loaded.data, resource.fields, maskText), file: loaded.file ? (mark ? stampFile(loaded.file, mark) : loaded.file) : null, mark };
  });
}

/**
 * GET /public/share/:token (M9-D823 §3 item 4), sem login: conta o acesso do IP ANTES de qualquer consulta, resolve a empresa pelo hash do token, confere o limite (o da empresa
 * do link, ou o padrão para token que não existe) e abre o link só se ACTIVE e dentro do prazo, a cada acesso. Devolve `{ state, result }`; token malformado, inexistente,
 * expirado ou revogado dão a MESMA resposta 404 GOV_LINK_UNAVAILABLE (nunca revela a existência). `state` leva o contador para os cabeçalhos X-RateLimit-*.
 */
async function accessPublicShare({ token, ip, now = new Date() }) {
  const state = await limiter.countHit(ip);
  const route = looksLikeToken(token) ? await resolveRoute(hashToken(token)) : null;
  const tenant = route ? { groupId: route.groupId, companyId: route.companyId } : null;
  const limit = tenant ? await withOwnTenantTransaction(tenant, null, (tx) => limiter.limitFor(tenant, tx)) : await limiter.limitFor(null);
  state.limit = limit;
  limiter.assertWithinLimit(state, limit);
  if (!route) throw errors.unavailable();
  const result = await openLink(tenant, route, now);
  if (!result) throw errors.unavailable();
  return { state, result };
}

module.exports = { accessPublicShare };
