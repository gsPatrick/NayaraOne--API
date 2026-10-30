'use strict';

/** Status de custo (M9-D863 §3.4): OK, ATTENTION (>= 75%) ou CRITICAL (>= 100%). O pior vence. Nunca afeta a disponibilidade do sistema. */
const ORDER = Object.freeze(['OK', 'ATTENTION', 'CRITICAL']);

const statusOf = (percent) => (percent >= 100 ? 'CRITICAL' : percent >= 75 ? 'ATTENTION' : 'OK'); // eslint-disable-line no-nested-ternary
const worst = (list) => list.reduce((acc, s) => (ORDER.indexOf(s) > ORDER.indexOf(acc) ? s : acc), 'OK');

module.exports = { ORDER, statusOf, worst };
