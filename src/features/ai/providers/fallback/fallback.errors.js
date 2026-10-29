'use strict';

const AppError = require('../../../../utils/AppError');

/** Falha fechada do fallback (M9-D013). Mensagens do livro; HTTP 503 nos dois casos. */
const fallbackUnsafe = (details) => new AppError('A NAY não está disponível agora. Nenhuma ação foi executada.', 503, 'AI_FALLBACK_UNSAFE', details);
const providerUnavailable = (details) => new AppError('O provedor de IA está indisponível no momento.', 503, 'AI_PROVIDER_UNAVAILABLE', details);

module.exports = { fallbackUnsafe, providerUnavailable };
