'use strict';

const AppError = require('../../../../utils/AppError');

/** Erros da NAY Documental (M9-D040). Código estável, mensagem em português, sem o conteúdo do documento. */
const notVerified = () => new AppError('Este arquivo ainda não foi verificado pelo antivírus e não pode ser lido pela NAY.', 422, 'AI_DOCUMENT_NOT_VERIFIED');
const unsupported = () => new AppError('Este tipo de arquivo não pode ser lido pela NAY.', 422, 'AI_DOCUMENT_UNSUPPORTED');
const unreadable = () => new AppError('Não foi possível ler este arquivo.', 422, 'AI_DOCUMENT_UNREADABLE');
const ocrUnavailable = () => new AppError('Não há provedor de leitura de imagem disponível para este arquivo.', 503, 'AI_DOCUMENT_OCR_UNAVAILABLE');
const restricted = () => new AppError('Este documento é restrito e não pode ser lido pela NAY nesta consulta.', 403, 'AI_RESTRICTED_NOT_ALLOWED');

module.exports = { notVerified, unsupported, unreadable, ocrUnavailable, restricted };
