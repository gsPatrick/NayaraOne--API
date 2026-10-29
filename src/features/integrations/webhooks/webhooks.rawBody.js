'use strict';

const { platformBodyCeiling } = require('./webhooks.params');
const { tooLarge } = require('./webhooks.errors');
const { recordRefusal } = require('./webhooks.reject');

/**
 * Corpo bruto da rota pública (M9-D211 passo 1, M9-D213 3.2): `req.body` é um Buffer com os bytes EXATOS recebidos, qualquer Content-Type, sem descompactar nada (a
 * assinatura vale sobre o que o fornecedor enviou). O limite desta chamada (`req.webhookBodyLimit`, posto pelo passo anterior: parâmetro da empresa apertando o teto
 * da plataforma, ou a política do fornecedor até 10 MiB) vale ANTES de ler: o Content-Length maior é recusado sem ler byte e, sem Content-Length, a leitura PARA ao
 * passar do limite (nada além disso é guardado; o que ainda chega é descartado até 1 MiB acima do limite e por no máximo 2 s; passou disso a conexão é derrubada e o cliente pode ver um reset em vez do 413). Acima: 413 INTEGRATION_WEBHOOK_TOO_LARGE.
 * Também guarda o Buffer em `req.rawBody`, onde os serviços antigos o procuram.
 */
const LINGER_BYTES = 1048576;
const LINGER_MS = 2000;

/**
 * Depois de recusar, o que ainda chega do corpo é descartado (nunca guardado), até 1 MiB acima do limite e por no máximo 2 s; passou disso a conexão é derrubada. Assim o cliente que mandou
 * um pouco a mais lê o 413 em vez de levar um reset, e o cliente abusivo não prende a conexão nem a memória.
 */
function discardRest(req, jaLido, limit) {
  let descartado = 0;
  const teto = limit + LINGER_BYTES - jaLido;
  const timer = setTimeout(() => req.destroy(), LINGER_MS);
  timer.unref();
  req.on('data', (pedaco) => { descartado += pedaco.length; if (descartado > teto) req.destroy(); });
  req.on('end', () => clearTimeout(timer));
  req.on('close', () => clearTimeout(timer));
  req.on('error', () => {});
  req.resume();
}

async function refuseTooLarge(req, res, limit, jaLido, next) {
  discardRest(req, jaLido, limit);
  const intake = req.webhookIntake;
  if (intake) {
    await recordRefusal(intake.conn, {
      provider: intake.provider, channel: intake.channel, code: 'INTEGRATION_WEBHOOK_TOO_LARGE', httpStatus: 413, message: 'Webhook recusado: o corpo passou do tamanho máximo permitido.',
      sizeBytes: Number(req.headers['content-length']) || null, ip: req.ip, reason: `limite de ${limit} bytes`,
    });
  }
  next(tooLarge());
}

function rawBodyMiddleware(req, res, next) {
  const limit = req.webhookBodyLimit || platformBodyCeiling();
  const declarado = Number(req.headers['content-length']);
  if (Number.isFinite(declarado) && declarado > limit) {
    refuseTooLarge(req, res, limit, 0, next);
    return;
  }
  const pedacos = [];
  let lido = 0;
  let encerrado = false;
  const terminar = (fn) => { if (encerrado) return; encerrado = true; req.removeListener('data', aoLer); req.removeListener('end', aoFim); req.removeListener('error', aoErro); fn(); };
  function aoLer(pedaco) {
    lido += pedaco.length;
    if (lido > limit) {
      terminar(() => refuseTooLarge(req, res, limit, lido, next));
      return;
    }
    pedacos.push(pedaco);
  }
  function aoFim() {
    terminar(() => {
      req.body = Buffer.concat(pedacos, lido);
      req.rawBody = req.body;
      next();
    });
  }
  function aoErro(err) { terminar(() => next(err)); }
  req.on('data', aoLer);
  req.on('end', aoFim);
  req.on('error', aoErro);
}

module.exports = { rawBodyMiddleware };
