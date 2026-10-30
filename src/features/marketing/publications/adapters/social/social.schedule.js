'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../../models');
const { SOCIAL_NETWORKS } = require('./networks');
const { readSocialConfig } = require('./social.settings');
const { assertContentFits } = require('./social.capabilities');
const { contentOf } = require('./social.adapter');
const { watermarkFor } = require('./social.watermark');
const { providerAuthFailed, AUTH_CODE } = require('./social.errors');

const isSocial = (channel) => SOCIAL_NETWORKS.includes(channel);

/**
 * Validação de capability ANTES de agendar (M9-D428 regra 2): cada rede pedida confere legenda (com a marca de idempotência), formato, proporção, duração e tamanho da
 * mídia da versão contra as capabilities dela (parâmetros da empresa). A primeira violação é 422 MKT_CAPABILITY_VIOLATION com o limite e a rede; como roda antes de
 * qualquer job, uma rede fora do limite impede o agendamento inteiro e nenhum job nasce. Conteúdo sem mídia só confere a legenda.
 */
async function assertSocialCapabilities({ tenant, version, channels }, transaction) {
  const socials = channels.filter(isSocial);
  if (socials.length === 0) return;
  const config = await readSocialConfig(tenant, transaction);
  const body = (version && version.body_json) || {};
  const reserve = watermarkFor('reserva', { mode: config.mark, hashtagPrefix: config.prefix }).suffix.length;
  for (const network of socials) {
    assertContentFits({ network, caps: config.capabilities[network], content: contentOf({ texto: body.texto }, body.midia || null), tolerancePct: config.tolerancePct, reserve });
  }
}

/**
 * NEEDS_REAUTH da rede (M9-D428 regra 5): a conexão do framework é uma só por família e as redes a dividem, então pausá-la por causa de uma rede pararia as outras
 * (regra 4). O estado é por rede e derivado: o último job da rede que falhou com MKT_PROVIDER_AUTH_FAILED desde a última alteração da conexão. Reautorizar (nova
 * credencial, edição da conexão) atualiza a conexão e limpa o estado. Com conexão própria por rede, quem pausa é o bloco B (AUTH_FAILED) e esta conferência não muda.
 */
async function assertNetworkAuthorized({ tenant, channel, connection }, transaction) {
  if (!isSocial(channel) || !connection) return;
  const [row] = await sequelize.query(
    `SELECT id, updated_at FROM marketing.publication_jobs
      WHERE company_id = :companyId AND channel = :channel AND connection_id = :connectionId AND status = 'FAILED' AND last_error_code = :code AND deleted_at IS NULL
        AND updated_at >= :since
      ORDER BY updated_at DESC LIMIT 1`,
    { replacements: { companyId: tenant.companyId, channel, connectionId: connection.id, code: AUTH_CODE, since: connection.updatedAt || connection.updated_at || new Date(0) }, transaction, type: QueryTypes.SELECT }
  );
  if (row) throw providerAuthFailed({ channel, connectionId: connection.id, state: 'NEEDS_REAUTH', since: row.updated_at });
}

module.exports = { assertSocialCapabilities, assertNetworkAuthorized, isSocial };
