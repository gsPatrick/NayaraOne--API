'use strict';

const AppError = require('../../../utils/AppError');

/** Erros da ingestão e da busca do RAG (M9-D022 e M9-D023). Código estável, mensagem em português, sem detalhe técnico. */
const notAuthorized = () => AppError.forbidden('Você não pode indexar este documento.', 'AI_INGEST_NOT_AUTHORIZED');
const malware = () => new AppError('O arquivo foi rejeitado pela verificação de segurança.', 422, 'AI_INGEST_MALWARE');
const unclassified = () => new AppError('Classifique o documento antes de indexá-lo.', 422, 'AI_INGEST_UNCLASSIFIED');
const urlBlocked = () => new AppError('Esta URL não é permitida.', 422, 'AI_INGEST_URL_BLOCKED');
const restricted = () => new AppError('Documento restrito não é indexado nesta empresa.', 422, 'AI_INGEST_RESTRICTED_BLOCKED');
const unsupported = () => new AppError('Este tipo de documento não pode ser lido pela NAY.', 422, 'AI_INGEST_UNSUPPORTED');
const unreadable = () => new AppError('Não foi possível ler o texto deste documento.', 422, 'AI_INGEST_UNREADABLE');
const secrets = () => new AppError('O documento é majoritariamente composto de credenciais e não foi indexado.', 422, 'AI_INGEST_SECRETS');
const empty = () => new AppError('O documento não tem texto para indexar.', 422, 'AI_INGEST_EMPTY');
const sourceInvalid = () => new AppError('A origem a indexar não foi encontrada nesta empresa.', 404, 'AI_INGEST_SOURCE_NOT_FOUND');
const failed = () => new AppError('A ingestão falhou por um erro técnico. Reenvie o documento.', 502, 'AI_INGEST_FAILED');
const invalid = (message, details) => new AppError(message, 400, 'AI_INGEST_INVALID', details);
const notFound = () => AppError.notFound('Ingestão não encontrada.', 'AI_INGEST_NOT_FOUND');
const crossCompany = () => AppError.notFound('Dado não encontrado.', 'AI_CROSS_COMPANY_BLOCKED');
const searchInvalid = (message) => new AppError(message, 400, 'AI_RETRIEVAL_INVALID');
const classifyInvalid = (message) => new AppError(message, 400, 'AI_FILE_CLASSIFICATION_INVALID');

/** Código de rejeição (gravado em ai.ingestions.error_code) -> erro HTTP. */
const REJECTIONS = Object.freeze({
  AI_INGEST_MALWARE: malware,
  AI_INGEST_UNCLASSIFIED: unclassified,
  AI_INGEST_URL_BLOCKED: urlBlocked,
  AI_INGEST_RESTRICTED_BLOCKED: restricted,
  AI_INGEST_UNSUPPORTED: unsupported,
  AI_INGEST_UNREADABLE: unreadable,
  AI_INGEST_SECRETS: secrets,
  AI_INGEST_EMPTY: empty,
  AI_INGEST_FAILED: failed,
});

/** Recusa que o controller lança DEPOIS de gravar a linha (REJECTED/FAILED) para a resposta carregar o código do livro. */
function rejectionError(code, ingestionId) {
  const make = REJECTIONS[code] || failed;
  const err = make();
  err.details = { ...(err.details || {}), ingestionId };
  return err;
}

module.exports = {
  notAuthorized, malware, unclassified, urlBlocked, restricted, unsupported, unreadable, secrets, empty, sourceInvalid, failed, invalid, notFound,
  crossCompany, searchInvalid, classifyInvalid, rejectionError, REJECTIONS,
};
