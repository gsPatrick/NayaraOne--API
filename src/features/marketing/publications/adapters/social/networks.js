'use strict';

/**
 * M9-D428 — as cinco redes sociais e as capabilities de cada uma (formatos, proporções, duração máxima, tamanho máximo e limite de legenda). O que o livro fixa:
 * Instagram com legenda de 2.200 caracteres, reel 9:16 e feed 1:1 e 4:5; LinkedIn recebendo imagem 1,91:1. O resto são os limites publicados pelas redes na data da
 * entrega e são só o PADRÃO: o administrador ajusta cada rede no parâmetro `marketing.social.<rede>.capacidades` quando a rede mudar uma regra (DI-D428-2).
 * Proporção é "largura:altura" (aceita decimal, ex.: 1.91:1); duração em segundos; tamanho em MB; legenda em caracteres.
 */
const SOCIAL_NETWORKS = Object.freeze(['INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'YOUTUBE', 'TIKTOK']);
const FORMATS = Object.freeze(['IMAGE', 'CAROUSEL', 'VIDEO', 'REEL']);

const deepFreeze = (value) => {
  if (value && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

const DEFAULT_CAPABILITIES = deepFreeze({
  INSTAGRAM: {
    formatos: ['IMAGE', 'CAROUSEL', 'VIDEO', 'REEL'],
    proporcoes: { IMAGE: ['1:1', '4:5', '1.91:1'], CAROUSEL: ['1:1', '4:5'], VIDEO: ['1:1', '4:5'], REEL: ['9:16'] },
    duracaoMaxS: { VIDEO: 60, REEL: 90 },
    tamanhoMaxMb: { IMAGE: 8, CAROUSEL: 8, VIDEO: 100, REEL: 100 },
    legendaMax: 2200,
  },
  FACEBOOK: {
    formatos: ['IMAGE', 'CAROUSEL', 'VIDEO', 'REEL'],
    proporcoes: { IMAGE: ['1:1', '4:5', '1.91:1', '16:9'], CAROUSEL: ['1:1', '1.91:1'], VIDEO: ['1:1', '4:5', '16:9', '9:16'], REEL: ['9:16'] },
    duracaoMaxS: { VIDEO: 7200, REEL: 90 },
    tamanhoMaxMb: { IMAGE: 10, CAROUSEL: 10, VIDEO: 1024, REEL: 1024 },
    legendaMax: 63206,
  },
  LINKEDIN: {
    formatos: ['IMAGE', 'CAROUSEL', 'VIDEO'],
    proporcoes: { IMAGE: ['1.91:1', '1:1', '4:5'], CAROUSEL: ['1:1', '1.91:1'], VIDEO: ['16:9', '1:1', '4:5', '9:16'] },
    duracaoMaxS: { VIDEO: 600 },
    tamanhoMaxMb: { IMAGE: 5, CAROUSEL: 100, VIDEO: 200 },
    legendaMax: 3000,
  },
  YOUTUBE: {
    formatos: ['VIDEO', 'REEL'],
    proporcoes: { VIDEO: ['16:9'], REEL: ['9:16'] },
    duracaoMaxS: { VIDEO: 43200, REEL: 60 },
    tamanhoMaxMb: { VIDEO: 262144, REEL: 262144 },
    legendaMax: 5000,
  },
  TIKTOK: {
    formatos: ['VIDEO', 'REEL'],
    proporcoes: { VIDEO: ['9:16', '1:1', '16:9'], REEL: ['9:16'] },
    duracaoMaxS: { VIDEO: 600, REEL: 600 },
    tamanhoMaxMb: { VIDEO: 500, REEL: 500 },
    legendaMax: 2200,
  },
});

module.exports = { SOCIAL_NETWORKS, FORMATS, DEFAULT_CAPABILITIES, deepFreeze };
