'use strict';

const { assertOutboundAllowed } = require('../../killswitch.state');
const { resolveChannelConnection } = require('./schedule.connection');
const { publicFieldsNotSanitized } = require('./schedule.errors');
const social = require('../adapters/social');

/**
 * Pré-condições do agendamento, todas rechecadas no momento de agendar (M9-D410 item 2), nesta ordem: (1) kill switch global, do canal ou da campanha, com falha
 * fechada (423 MKT_KILL_SWITCH_ACTIVE, da fachada da M9-D425); (2) campos públicos sanitizados (o passo de compliance da versão está ok) e, no reel, a mídia ainda autorizada (M9-D426); (3) conexão do canal ativa
 * e saudável. Item aprovado, hash coerente e antecedência mínima ficam com o chamador (a aprovação invalida antes de gravar). Devolve a conexão de cada canal.
 */
async function assertSchedulable({ tenant, actor, item, version, channels, transaction }) {
  await assertOutboundAllowed(tenant, { channel: channels, campaignId: item.campaign_id }, transaction);
  const compliance = version && version.checks_json ? version.checks_json.compliance : null;
  if (!compliance || compliance.ok !== true) throw publicFieldsNotSanitized({ contentItemId: item.id, versionId: version ? version.id : null });
  if (item.type === 'VIDEO_REEL') await require('../../content').video.resolveMedia((version.body_json || {}).midiaId, transaction); // M9-D426: mídia revogada depois da criação não agenda
  await social.assertSocialCapabilities({ tenant, version, channels }, transaction); // M9-D428: limites da rede antes de qualquer job
  const connections = {};
  for (const channel of channels) connections[channel] = await resolveChannelConnection({ tenant, actor, channel, transaction });
  return connections;
}

module.exports = { assertSchedulable };
