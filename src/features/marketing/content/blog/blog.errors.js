'use strict';

const { mktError } = require('../../marketing.errors');

/** Erros do blog educativo (M9-D427 seção 4): código MKT_ e mensagem em português. */
const blogSourcesRequired = (details) => mktError(422, 'MKT_BLOG_SOURCES_REQUIRED', 'O artigo precisa citar fontes permitidas.', details);
const blogQualityFailed = (details) => mktError(422, 'MKT_BLOG_QUALITY_FAILED', 'O artigo falhou na verificação de qualidade.', details);

module.exports = { blogSourcesRequired, blogQualityFailed };
