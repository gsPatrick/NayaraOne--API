'use strict';

/**
 * Motivo, em português, de a mensagem não ter sido entregue (M9-D230 3.4): o que o usuário lê na interação FAILED. Nunca texto do fornecedor nem o conteúdo da mensagem.
 */
const POR_CODIGO = Object.freeze([
  [/INVALID_NUMBER|PHONE_INVALID|NUMBER/i, 'O número não existe no WhatsApp ou é inválido.'],
  [/BLOCK/i, 'O número bloqueou ou não aceita mensagens da empresa.'],
  [/TEMPLATE/i, 'O modelo de mensagem foi rejeitado pelo fornecedor.'],
  [/MEDIA/i, 'A mídia foi recusada pelo fornecedor.'],
  [/AUTH|CREDENTIAL/i, 'A integração de mensagens está sem autorização: o envio não foi feito.'],
  [/RATE|QUOTA|429/i, 'O fornecedor limitou os envios: a mensagem não foi aceita.'],
]);

const RECUSA_DE_DADOS = 'O fornecedor recusou a mensagem: número inexistente ou bloqueado, modelo ou mídia rejeitados.';
const PADRAO_ENVIO = 'O fornecedor não conseguiu enviar a mensagem.';
const PADRAO_ENTREGA = 'O fornecedor informou que a mensagem não foi entregue (número inexistente, bloqueado ou modelo rejeitado).';

/** Motivo para um envio que terminou em falha (`integration.dispatch.failed`): pelo código de erro registrado. */
function reasonForDispatchFailure({ errorCode, errorClass } = {}) {
  const chave = `${errorCode || ''} ${errorClass || ''}`;
  const achado = POR_CODIGO.find(([re]) => re.test(chave));
  if (achado) return achado[1];
  return String(errorClass || '').toUpperCase() === 'VALIDATION' ? RECUSA_DE_DADOS : PADRAO_ENVIO;
}

module.exports = { reasonForDispatchFailure, PADRAO_ENTREGA };
