'use strict';

/** M9-D686 — as cores do semáforo e o texto que sempre as acompanha (acessibilidade: a cor nunca é a única informação). A cinza nunca vale verde. */
const COLORS = Object.freeze({
  VERDE: { color: 'VERDE', rank: 0, text: 'Verde: em ordem' },
  AMARELO: { color: 'AMARELO', rank: 1, text: 'Amarelo: atenção' },
  VERMELHO: { color: 'VERMELHO', rank: 2, text: 'Vermelho: ação necessária' },
  CINZA: { color: 'CINZA', rank: -1, text: 'Cinza: sem dados suficientes' },
});

const NO_DATA_TEXT = 'Sem dados suficientes';
const NO_ACCESS_TEXT = 'Sem acesso';

const lightView = (color, text) => ({ color: COLORS[color].color, text: text || COLORS[color].text });
/** A mais grave entre as cores VERDE, AMARELO e VERMELHO (a lista vazia é VERDE). */
const worst = (colors) => colors.reduce((acc, c) => (COLORS[c].rank > COLORS[acc].rank ? c : acc), 'VERDE');

module.exports = { COLORS, NO_DATA_TEXT, NO_ACCESS_TEXT, lightView, worst };
