'use strict';

const { success } = require('../../../../../utils/httpResponse');
const { receiveChannelWebhook } = require('./webhook.service');

/** POST /marketing/webhooks/:channel (pública). O corpo bruto é o que o parser de JSON da plataforma guardou em req.rawBody. */
async function receive(req, res) {
  const data = await receiveChannelWebhook({
    channel: req.params.channel, provider: req.query.provider, token: req.query.token, headers: req.headers, rawBody: req.rawBody, ip: req.ip,
  });
  return success(res, { data });
}

module.exports = { receive };
