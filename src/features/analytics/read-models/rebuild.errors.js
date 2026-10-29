'use strict';

/** M9-D608 — erros de negócio do rebuild, com os códigos e as mensagens do livro/demanda. */
const AppError = require('../../../utils/AppError');

const disabled = () => AppError.forbidden('Reconstrução desabilitada neste ambiente.', 'ANALYTICS_REBUILD_DISABLED');
const inProgress = () => AppError.conflict('Já existe uma reconstrução em andamento para este modelo.', 'ANALYTICS_REBUILD_IN_PROGRESS');
const qualityFailed = (checks) => AppError.unprocessable('Reconstrução abortada: o resultado não passou nas verificações de qualidade.', 'ANALYTICS_REBUILD_QUALITY_FAILED', { checks });
const reasonRequired = (diff) => AppError.unprocessable('O resultado da reconstrução difere do atual: informe o motivo (--motivo).', 'ANALYTICS_REBUILD_REASON_REQUIRED', { diff });
const notSupported = (model) => AppError.unprocessable(`O read model ${model} não declara como enumerar seus agregados (rebuild.keys).`, 'ANALYTICS_REBUILD_NOT_SUPPORTED', { model });
const unknownModel = (model) => AppError.notFound(`Read model não encontrado: ${model}.`, 'ANALYTICS_READ_MODEL_NOT_FOUND', { model });
const companyNotFound = () => AppError.notFound('Empresa não encontrada ou sem acesso.', 'ANALYTICS_SCOPE_NOT_FOUND');

module.exports = { disabled, inProgress, qualityFailed, reasonRequired, notSupported, unknownModel, companyNotFound };
