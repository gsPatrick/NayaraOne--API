'use strict';

/**
 * Chaves e padrões dos domínios da empresa que o Marketing reconhece como próprios: a URL base do site (SEO) e os domínios próprios do blog. Ficam na raiz do módulo (e não
 * numa das áreas) porque a segurança (regra de URL externa, M9-D433), as publicações (SEO) e o conteúdo (blog) leem as mesmas duas chaves, e uma área não importa a outra por
 * caminho interno (M9-D402). Os arquivos de parâmetros de SEO e do blog reexportam estas constantes.
 */
const BASE_URL_KEY = 'marketing.seo.url_base';
const NO_BASE_URL = 'nenhuma';
const OWN_DOMAINS_KEY = 'marketing.blog.dominios_empresa';
const NO_DOMAINS = 'nenhum';

/** "gov.br, IBGE.gov.br" -> ['gov.br','ibge.gov.br'] (minúsculas, sem vazios nem repetidos; "nenhum" = lista vazia). */
function parseDomains(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  if (!raw || raw.toLowerCase() === NO_DOMAINS) return [];
  return [...new Set(raw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean))];
}

module.exports = { BASE_URL_KEY, NO_BASE_URL, OWN_DOMAINS_KEY, NO_DOMAINS, parseDomains };
