'use strict';

const { channelNotReleased } = require('../channel.errors');

/**
 * Prova de que o canal está liberado. Só channelAccess.resolveChannelAdapter, depois de conferir o parâmetro `marketing.channel.<canal>.liberado`,
 * emite a prova; o adapter REAL recusa nascer sem ela (409 MKT_CHANNEL_NOT_RELEASED). Assim nenhuma chamada a provedor real sai de canal não liberado,
 * nem por engano de quem monta o adapter. O teste de arquitetura reprova outro arquivo que emita a prova.
 */
const PROOF = Symbol('mkt.channel.released');

const mintReleaseProof = () => PROOF;

function assertReleaseProof(proof, channel) {
  if (proof !== PROOF) throw channelNotReleased({ channel });
}

module.exports = { mintReleaseProof, assertReleaseProof };
