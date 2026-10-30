'use strict';

/**
 * WhatsAppAdapter (M9-D429 regra 2) — monta a mensagem de WhatsApp para o ChannelAdapter da M9-D430. Dentro da janela de atendimento de 24 h vale
 * texto livre transacional; fora dela só template oficial aprovado (a decisão da janela é do canSend, M9-D418, que olha a última mensagem recebida da
 * pessoa). O preview é o começo do texto (os `maxChars` primeiros caracteres) e é o que a verificação sensível examina.
 */
function buildWhatsappMessage({ to, text, template, variables }) {
  if (template) return { to, type: 'template', templateRef: template.official_template_ref, templateName: template.code, variables: variables || {}, text };
  return { to, type: 'text', text };
}

/** Os trechos que aparecem na notificação do celular: [{ field, value, maxChars }]. */
const previewFields = (message, previewConfig) => [{ field: 'text', value: message.text, maxChars: previewConfig.maxChars }];

module.exports = { buildWhatsappMessage, previewFields };
