'use strict';

/**
 * EmailAdapter (M9-D429 regra 3) — monta o e-mail para o ChannelAdapter da M9-D430. Mensagem de marketing sempre leva o link de descadastro no rodapé
 * e o cabeçalho List-Unsubscribe (com o One-Click da RFC 8058), para o opt-out chegar à supressão (M9-D418). O preview do e-mail é o assunto e o
 * pré-cabeçalho inteiros.
 */
function buildEmailMessage({ to, subject, preheader, text, unsubscribeUrl }) {
  const footer = unsubscribeUrl ? `\n\nPara não receber mais mensagens, acesse: ${unsubscribeUrl}` : '';
  return {
    to,
    subject,
    ...(preheader ? { preheader } : {}),
    text: `${text}${footer}`,
    headers: unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {},
  };
}

const previewFields = (message) => [
  { field: 'subject', value: message.subject },
  ...(message.preheader ? [{ field: 'preheader', value: message.preheader }] : []),
];

module.exports = { buildEmailMessage, previewFields };
