'use strict';

/**
 * Erros da LEITURA do pedido, antes de qualquer rota (verificação independente do Marco 9, rodada 6, 12/11/2026; DI-M9R-14): o leitor do corpo
 * (body-parser e raw-body, inclusive a descompressão), a decodificação do caminho (Express) e o texto que o banco não grava. Todos são do pedido
 * enviado, nunca do servidor: viram 400, 413 ou 415 com o código de erro da API. Antes só `entity.too.large` e `entity.parse.failed` eram tratados; o
 * resto (charset latin1 ou inexistente, gzip ou deflate quebrado, Content-Encoding br ou desconhecido, escape `%` malformado no caminho) caía no 500.
 */
const FROM_BODY_READER = Symbol('nayara.fromBodyReader');

const ILEGIVEL = 'O corpo da requisição não pôde ser lido.';

/** `type` dos erros do body-parser 1.x e do raw-body 2.x -> [status, código, mensagem]. */
const POR_TIPO = Object.freeze({
  'encoding.unsupported': [415, 'REQUEST_BODY_ENCODING_UNSUPPORTED', 'A compressão do corpo (Content-Encoding) não é aceita. Envie o corpo sem compressão, em gzip ou em deflate.'],
  'charset.unsupported': [415, 'REQUEST_BODY_CHARSET_UNSUPPORTED', 'O conjunto de caracteres do corpo (charset) não é aceito. Envie o corpo em UTF-8.'],
  // Os dois abaixo mantêm o código e o status que a API já devolvia (Marco 6 e Marco 8).
  'entity.parse.failed': [400, 'INVALID_JSON_BODY', 'O corpo da requisição não é um JSON válido.'],
  'entity.too.large': [400, 'FILE_UPLOAD_TOO_LARGE', 'O arquivo enviado é grande demais.'],
  'entity.verify.failed': [400, 'INVALID_REQUEST_BODY', ILEGIVEL],
  'parameters.too.many': [413, 'REQUEST_BODY_TOO_MANY_PARAMETERS', 'O formulário enviado tem campos demais.'],
  'querystring.parse.rangeError': [400, 'INVALID_REQUEST_BODY', 'O formulário enviado passa da profundidade aceita.'],
  'request.aborted': [400, 'REQUEST_BODY_ABORTED', 'O envio do corpo foi interrompido antes do fim.'],
  'request.size.invalid': [400, 'REQUEST_BODY_SIZE_MISMATCH', 'O tamanho do corpo não confere com o cabeçalho Content-Length.'],
  // Os dois abaixo nascem de outro middleware ter lido o corpo antes (falha de montagem, não do cliente): a resposta é 400 como os demais erros do
  // leitor, e o registro sai como erro (logServerSide) para a montagem ser corrigida.
  'stream.encoding.set': [400, 'REQUEST_BODY_UNREADABLE', ILEGIVEL, true],
  'stream.not.readable': [400, 'REQUEST_BODY_UNREADABLE', ILEGIVEL, true],
});

/** Marca o erro que saiu do leitor do corpo: qualquer erro dali é do corpo enviado (ex.: o zlib não traz `type`, só `code: 'Z_DATA_ERROR'`). */
function markBodyReaderError(err) {
  if (err && typeof err === 'object') {
    try { Object.defineProperty(err, FROM_BODY_READER, { value: true }); } catch (_e) { /* objeto congelado: o `type` ainda é conferido */ }
  }
  return err;
}

/** O leitor do corpo com o erro marcado: `app.use(guardBodyReader(express.json({ ... })))`. */
const guardBodyReader = (parser) => (req, res, next) => parser(req, res, (err) => next(err ? markBodyReaderError(err) : undefined));

const isZlibError = (err) => typeof err.code === 'string' && /^Z_[A-Z_]+$/.test(err.code);
const statusDoLeitor = (err) => ([400, 413, 415].includes(err.status) ? err.status : 400);

/**
 * Erro do leitor do corpo -> { statusCode, code, message, logServerSide } ou null. Conhece cada `type` do body-parser e do raw-body; o erro marcado
 * sem `type` conhecido (descompressão quebrada, por exemplo) vira 400 pelo status que ele já traz.
 */
function mapBodyReaderError(err) {
  if (!err || typeof err !== 'object') return null;
  const conhecido = typeof err.type === 'string' && Object.prototype.hasOwnProperty.call(POR_TIPO, err.type) ? POR_TIPO[err.type] : null;
  if (conhecido) {
    const [statusCode, code, message, logServerSide = false] = conhecido;
    return { statusCode, code, message, logServerSide };
  }
  // SyntaxError do JSON.parse que algum leitor repassou sem `type` (mesma regra que já valia no errorHandler).
  if (err instanceof SyntaxError && 'body' in err) return { statusCode: 400, code: 'INVALID_JSON_BODY', message: POR_TIPO['entity.parse.failed'][2], logServerSide: false };
  if (!err[FROM_BODY_READER]) return null;
  if (isZlibError(err)) return { statusCode: 400, code: 'REQUEST_BODY_DECOMPRESSION_FAILED', message: 'O corpo comprimido (Content-Encoding) não pôde ser descompactado.', logServerSide: false };
  return { statusCode: statusDoLeitor(err), code: 'INVALID_REQUEST_BODY', message: ILEGIVEL, logServerSide: false };
}

/** Escape `%` malformado num parâmetro do caminho (`/messages/%E0%A4%A`): o Express lança URIError com status 400 antes de chegar à rota. */
function mapPathDecodeError(err) {
  if (!(err instanceof URIError) || (err.status !== 400 && err.statusCode !== 400)) return null;
  return { statusCode: 400, code: 'INVALID_ID_FORMAT', message: 'O identificador informado não é válido.' };
}

/**
 * Texto que o banco não grava e que chegou ao banco por um caminho que a porta (storableText.middleware.js) não vê, como o parâmetro do caminho:
 * 22021 (caractere nulo num texto), 22P05 (`\u0000` num jsonb) e 22P02 do tipo json (metade solta de par sub-rogado). É o pedido, não o servidor.
 */
function mapUnstorableTextDbError(err) {
  const pg = err && err.name === 'SequelizeDatabaseError' ? err.parent || err.original : null;
  if (!pg) return null;
  const json = pg.code === '22P02' && /type json/i.test(String(pg.message || ''));
  if (pg.code !== '22021' && pg.code !== '22P05' && !json) return null;
  return {
    statusCode: 400,
    code: 'INVALID_TEXT_CHARACTER',
    message: 'Um texto enviado tem um caractere que não pode ser gravado (caractere nulo ou metade solta de um caractere Unicode). Remova o caractere e envie de novo.',
  };
}

module.exports = { guardBodyReader, markBodyReaderError, mapBodyReaderError, mapPathDecodeError, mapUnstorableTextDbError, POR_TIPO };
