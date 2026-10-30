'use strict';

/**
 * Ganchos do webhook de canal (M9-D429): quem precisa reagir a um evento aceito de um canal (ex.: status de entrega do WhatsApp e do e-mail aplicado à mensagem
 * do CRM) se registra aqui. O gancho roda na MESMA transação que gravou o evento na caixa de entrada e só para evento NOVO (o duplicado não chega aqui).
 * `hook({ tenant, channel, event }, transaction)`; erro de um gancho desfaz o evento inteiro (o provedor reenvia).
 */
const hooks = [];

function registerWebhookEventHook(hook) {
  if (typeof hook !== 'function') throw new TypeError('O gancho do webhook precisa ser uma função.');
  if (!hooks.includes(hook)) hooks.push(hook);
}

async function runWebhookEventHooks(args, transaction) {
  for (const hook of hooks) await hook(args, transaction); // eslint-disable-line no-await-in-loop -- em ordem de registro, na mesma transação
}

module.exports = { registerWebhookEventHook, runWebhookEventHooks };
