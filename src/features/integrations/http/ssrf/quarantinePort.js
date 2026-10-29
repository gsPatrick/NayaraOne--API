'use strict';

/**
 * Porta da quarentena (M9-D245 3.1 item 7). Todo conteúdo baixado de URL de terceiro entra por aqui e nunca é devolvido como
 * liberado: o chamador recebe o conteúdo marcado QUARANTINED e sem permissão de uso até a verificação. A área de quarentena
 * em disco, o antivírus e a promoção para `files` são da M9-D247, que registra o sink real com registerQuarantineSink.
 * Enquanto não houver sink, o conteúdo fica só na memória de quem chamou, sem gravação nem link.
 */
let sink = null;

const registerQuarantineSink = (fn) => { sink = typeof fn === 'function' ? fn : null; };
const hasQuarantineSink = () => sink !== null;

/** Entrega { buffer, contentType, sha256, origin } à quarentena e devolve o selo que acompanha o conteúdo. */
async function deliverToQuarantine(item) {
  let ref = null;
  if (sink) ref = await sink(item);
  return Object.freeze({ status: 'QUARANTINED', released: false, ref: ref ?? null, sink: sink ? 'registered' : 'none' });
}

module.exports = { registerQuarantineSink, hasQuarantineSink, deliverToQuarantine };
