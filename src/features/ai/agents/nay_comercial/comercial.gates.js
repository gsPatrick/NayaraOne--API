'use strict';

// M9-D034 — a tool `crm.createFollowUpTask` NÃO está na allowlist do piloto. Só passa a valer, como PROPOSTA (D019), enquanto a empresa
// mantém `ia.comercial.permitir_propostas` Ligado (e a trava de gravação já exigiu avaliação e homologação). Quem decide é o servidor a
// cada run; o modelo não vê nem escolhe isso.
const { registerToolAddition } = require('../toolGates');
const { proposalsAllowed } = require('./comercial.params');
const { CODE, PROPOSAL_TOOL } = require('./comercial.policy');

function registerComercialGates() {
  registerToolAddition(CODE, PROPOSAL_TOOL, (ctx, transaction) => proposalsAllowed(ctx, transaction));
}

module.exports = { registerComercialGates };
