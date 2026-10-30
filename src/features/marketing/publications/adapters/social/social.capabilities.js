'use strict';

const { ratioMatches } = require('./social.ratio');
const { capabilityViolation } = require('./social.errors');

const MB = 1024 * 1024;

/** REEL cai para VIDEO na rede que não tem reel (o LinkedIn publica o mesmo vídeo vertical como vídeo comum). */
function resolveFormat(format, caps) {
  if (format === 'REEL' && !caps.formatos.includes('REEL')) return 'VIDEO';
  return format;
}

/**
 * Confere o conteúdo contra as capabilities da rede e devolve TODAS as violações { limit, max|allowed, actual }. `content`: { caption, format, ratio, durationS, sizeBytes };
 * campo desconhecido (por exemplo a duração de um vídeo original que ninguém mediu) não é conferido. `reserve` = caracteres que a marca de idempotência ocupa na legenda.
 */
function checkContentFits({ caps, content, tolerancePct = 2, reserve = 0 }) {
  const violations = [];
  const format = content.format ? resolveFormat(content.format, caps) : null;
  if (format) {
    if (!caps.formatos.includes(format)) violations.push({ limit: 'FORMAT', allowed: caps.formatos, actual: content.format });
    else {
      const allowed = (caps.proporcoes || {})[format];
      if (content.ratio && allowed && !ratioMatches(content.ratio, allowed, tolerancePct)) violations.push({ limit: 'ASPECT_RATIO', allowed, actual: content.ratio, format });
      const maxS = (caps.duracaoMaxS || {})[format];
      if (Number.isFinite(content.durationS) && maxS && content.durationS > maxS) violations.push({ limit: 'DURATION_MAX', max: maxS, actual: content.durationS, format });
      const maxMb = (caps.tamanhoMaxMb || {})[format];
      if (Number.isFinite(content.sizeBytes) && maxMb && content.sizeBytes > maxMb * MB) violations.push({ limit: 'SIZE_MAX', maxMb, actualMb: Math.ceil(content.sizeBytes / MB), format });
    }
  }
  const length = String(content.caption || '').length + reserve;
  if (length > caps.legendaMax) violations.push({ limit: 'CAPTION_MAX', max: caps.legendaMax, actual: length });
  return violations;
}

/** Como checkContentFits, mas lança 422 MKT_CAPABILITY_VIOLATION com a primeira violação (o limite violado em details.limit). */
function assertContentFits({ network, ...rest }) {
  const [first, ...others] = checkContentFits(rest);
  if (first) throw capabilityViolation({ channel: network, ...first, ...(others.length ? { others: others.map((v) => v.limit) } : {}) });
}

module.exports = { checkContentFits, assertContentFits, resolveFormat };
