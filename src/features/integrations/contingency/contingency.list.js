'use strict';

const { listActiveRows, toView } = require('./contingency.state');

/** Contingências ativas da empresa (para a faixa de aviso do Front e para a API administrativa). */
async function listActiveContingencies(ctx, transaction) {
  return (await listActiveRows(ctx, transaction)).map(toView);
}

module.exports = { listActiveContingencies };
