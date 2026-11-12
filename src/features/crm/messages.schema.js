'use strict';

const { DIRECTIONS, AUTHOR_TYPES, CHANNELS, MESSAGE_STATUSES, COLUMN_LIMITS } = require('./messages.constants');

/**
 * Esquema de entrada de cada rota de mensagem (verificação independente do Marco 9, rodada 5, 12/11/2026; DI-M9R-11). Corrigir campo por campo
 * deixava sempre um campo para trás (500 a cada rodada), então o corpo, a consulta e o id do caminho de cada rota passam inteiros por um esquema
 * FECHADO (Ajv, a biblioteca de esquema que a API já usa), antes de qualquer outra regra: campo que a rota não conhece, tipo errado (sem conversão),
 * valor fora da lista fechada ou do formato do banco, ou texto acima do tamanho da coluna é 400 `MESSAGE_VALIDATION` com o nome do campo.
 *
 * `descricao` (anotação, não valida nada) é o que a mensagem de erro diz que o campo deve ser. `enumSemCaixa` é a lista fechada aceita em
 * maiúsculas ou minúsculas (o serviço grava em maiúsculas, como sempre fez); `kind` continua exato, como sempre foi.
 *
 * Limites: os textos que vão a uma coluna limitada seguem a coluna (`externalMessageId` varchar(128), `purpose` pela CHECK da 753, `status`
 * pela lista fechada, que cabe no varchar(32)). Os textos livres (`body` vai a uma coluna TEXT; `text`, `caption` e as variáveis do modelo vão ao
 * envio) não têm limite de tamanho: o livro não fixa um e o banco aceita qualquer tamanho. O destinatário (`to`), o modelo (`templateName`) e o
 * idioma (`language`) são conferidos pela regra da demanda (telefone E.164: 422 `INTEGRATION_MESSAGING_PHONE_INVALID`, M9-D229 3.2 item 4;
 * modelo aprovado no idioma: 422 `INTEGRATION_MESSAGING_TEMPLATE_NOT_APPROVED`, M9-D230 3.1); o esquema exige que sejam texto.
 */
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** Referência opcional: UUID em texto; ausente, null ou "" é "sem vínculo" (DI-M9R-8). */
const referencia = { type: ['string', 'null'], pattern: `^(?:|${UUID_PATTERN.slice(1, -1)})$`, descricao: 'um identificador (UUID) em texto' };
const idDoCaminho = { type: 'string', pattern: UUID_PATTERN, descricao: 'um identificador (UUID)' };
const listaFechada = (lista, { nulo = false } = {}) => ({ type: nulo ? ['string', 'null'] : 'string', enumSemCaixa: lista, descricao: `um de: ${lista.join(', ')}` });
const texto = (max) => ({ type: ['string', 'null'], ...(max ? { maxLength: max } : {}), descricao: max ? `um texto de até ${max} caracteres` : 'um texto' });
/** Campo que só o servidor define: qualquer valor é descartado pelo controller (DI-M9R-9 e M9-D229), como antes. */
const doServidor = { descricao: 'definido pelo servidor (o valor enviado é descartado)' };

const objetoFechado = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const semCorpo = objetoFechado({});
const comId = objetoFechado({ id: idDoCaminho }, ['id']);

const ROTAS = Object.freeze({
  /** POST /messages — registro de interação (livro, Marco 3 §10). */
  criar: {
    body: objetoFechado({
      personId: referencia,
      opportunityId: referencia,
      conversationId: referencia,
      mediaQuarantineId: referencia,
      channel: listaFechada(CHANNELS, { nulo: true }),
      direction: listaFechada(DIRECTIONS),
      authorType: listaFechada(AUTHOR_TYPES),
      body: texto(),
      externalMessageId: texto(COLUMN_LIMITS.externalMessageId),
      purpose: { type: ['string', 'null'], pattern: '^(?:|[A-Za-z0-9_]{2,40})$', descricao: 'um texto de 2 a 40 letras sem acento, números ou "_"' },
      authorUserId: doServidor,
      connectionId: doServidor,
      dispatchId: doServidor,
      deliveryStatus: doServidor,
      groupId: doServidor,
      companyId: doServidor,
    }, ['direction', 'authorType']),
  },
  /** POST /messages/send — envio pelo fornecedor de mensageria (M9-D229, M9-D230). */
  enviar: {
    body: objetoFechado({
      kind: { type: 'string', enum: ['text', 'template', 'media'], descricao: 'um de: text, template, media' },
      personId: referencia,
      opportunityId: referencia,
      conversationId: referencia,
      to: { type: ['string', 'null'], descricao: 'um telefone em texto' },
      text: texto(),
      templateName: texto(),
      language: texto(),
      templateVars: { type: ['array', 'null'], items: { type: 'string' }, descricao: 'uma lista de textos' },
      purpose: { type: ['string', 'null'], pattern: '^(?:|[A-Za-z0-9_]{2,40})$', descricao: 'um texto de 2 a 40 letras sem acento, números ou "_"' },
      mediaRef: { ...referencia, descricao: 'o identificador (UUID) do arquivo, em texto' },
      caption: texto(),
    }, ['kind']),
  },
  /** PATCH /messages/:id/status — só a lista fechada de status da mensagem. */
  status: {
    params: comId,
    body: objetoFechado({ status: listaFechada(MESSAGE_STATUSES) }, ['status']),
  },
  /** POST /messages/:id/send-alternate e /refresh-status: só o id do caminho, sem corpo. */
  porId: { params: comId, body: semCorpo },
  /** GET /messages/:id. */
  ler: { params: comId },
  /** GET /messages — filtros por pessoa e oportunidade (um UUID cada). */
  listar: {
    query: objetoFechado({ personId: { ...referencia, type: 'string' }, opportunityId: { ...referencia, type: 'string' } }),
  },
});

/** Nome que a mensagem dá a cada parte do pedido quando o problema é a parte inteira (corpo que não é objeto, por exemplo). */
const PARTES = Object.freeze({ body: 'corpo do pedido', query: 'consulta', params: 'caminho' });

/** Campo retirado do corpo de POST /messages (DI-M9R-12): a chave de idempotência só nasce pelas automações (M9-D415), nunca pelo cliente. */
const FORA_DA_ROTA = Object.freeze({
  actionKey: 'A chave de idempotência da mensagem só é gerada pelas automações e campanhas (M9-D415); para não repetir um registro, use o "externalMessageId".',
});

module.exports = { ROTAS, PARTES, FORA_DA_ROTA, UUID_PATTERN };
