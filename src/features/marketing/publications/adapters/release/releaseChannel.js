'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../../models');
const { upsertSetting } = require('../../../../settings/settings.service');
const { CHANNELS, releaseKey } = require('../channels');
const { RELEASED, NOT_RELEASED } = require('../channel.settings');
const { releasePrereqMissing, normalizeChannel } = require('../channel.errors');
const { runChannelContract } = require('../contract/channelContract.run');
const { runAsReleaseService } = require('./releaseScope');
const { isChannelReleased } = require('./channelAccess');
const { assertManage, assertReason, audit, readEvidence } = require('./evidence');

/** Pré-requisitos em ordem fixa: contrato (ao vivo, no sandbox do canal), failure drill, política de consentimento e homologação do adapter. */
async function evaluatePrerequisites(channel, tenant, transaction) {
  const contract = await runChannelContract(channel);
  const evidence = await readEvidence(channel, tenant, transaction);
  return [{ item: 'CONTRACT_TESTS', ok: contract.ok, at: null, by: null }, ...evidence];
}

const summary = (list) => list.map(({ item, ok, at }) => ({ item, ok, at }));

/**
 * releaseChannel — libera o canal para produção (M9-D430 3.6). Serviço SEM rota HTTP (padrão do liftSuppression): exige marketing:killswitch:manage e motivo e,
 * antes de gravar, confere os quatro pré-requisitos; faltando qualquer um, 422 MKT_CHANNEL_RELEASE_PREREQ_MISSING listando-os e nada é gravado.
 * Grava o parâmetro `marketing.channel.<canal>.liberado` = ligado (o histórico do parâmetro é o registro de homologação: quem e quando) e audita antes e depois.
 * Canal já liberado devolve replay. Retorna { channel, released, replay }.
 */
async function releaseChannel(channelName, { reason }, { tenant, actor, permissions }, transaction) {
  assertManage(permissions);
  const channel = normalizeChannel(channelName);
  const why = assertReason(reason);
  if (await isChannelReleased(channel, tenant, transaction)) return { channel, released: true, replay: true };
  const prerequisites = await evaluatePrerequisites(channel, tenant, transaction);
  const missing = prerequisites.filter((p) => !p.ok).map((p) => p.item);
  if (missing.length) throw releasePrereqMissing(missing, channel);
  await runAsReleaseService(() => upsertSetting(releaseKey(channel), RELEASED, tenant, actor, transaction));
  await audit({ tenant, actor }, { action: 'marketing.channel.released', channel, before: { released: false }, after: { channel, released: true, prerequisites: summary(prerequisites) }, reason: why }, transaction);
  return { channel, released: true, replay: false };
}

/** Volta o canal para o sandbox (mesma permissão, só pelo serviço, com motivo e auditoria). Canal já desligado devolve replay. */
async function revokeChannelRelease(channelName, { reason }, { tenant, actor, permissions }, transaction) {
  assertManage(permissions);
  const channel = normalizeChannel(channelName);
  const why = assertReason(reason);
  if (!(await isChannelReleased(channel, tenant, transaction))) return { channel, released: false, replay: true };
  await runAsReleaseService(() => upsertSetting(releaseKey(channel), NOT_RELEASED, tenant, actor, transaction));
  await audit({ tenant, actor }, { action: 'marketing.channel.release_revoked', channel, before: { released: true }, after: { channel, released: false }, reason: why }, transaction);
  return { channel, released: false, replay: false };
}

/** Quem e quando ligou o parâmetro (homologated_by / homologated_at): vem do histórico nativo da configuração, não de tabela própria. */
async function channelHomologation(channelName, tenant, transaction) {
  const channel = normalizeChannel(channelName);
  const [row] = await sequelize.query(
    `SELECT occurred_at, user_id FROM audit.audit_log
      WHERE company_id = :companyId AND entity_type = 'TenantSetting' AND after_json->>'key' = :key AND after_json->>'value' = :value
      ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    { replacements: { companyId: tenant.companyId, key: releaseKey(channel), value: RELEASED }, type: QueryTypes.SELECT, transaction },
  );
  return { channel, homologatedBy: row ? row.user_id : null, homologatedAt: row ? row.occurred_at : null };
}

/** Estado de cada canal para a empresa: liberado ou sandbox, e quem/quando liberou. */
async function listChannelStatus(tenant, transaction) {
  const out = [];
  for (const channel of CHANNELS) {
    const released = await isChannelReleased(channel, tenant, transaction);
    out.push({ channel, released, mode: released ? 'PRODUCTION' : 'SANDBOX', ...(released ? await channelHomologation(channel, tenant, transaction) : {}) });
  }
  return out;
}

module.exports = { releaseChannel, revokeChannelRelease, channelHomologation, listChannelStatus, evaluatePrerequisites };
