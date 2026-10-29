'use strict';

const { PENDENCY_CODE } = require('./data-quality.constants');

/** Pendências de um domínio (M9-D804 §3.2): sem owner vigente = CRITICAL; sem steward vigente = HIGH. */
const PENDENCY = Object.freeze({
  NO_OWNER: { code: PENDENCY_CODE.NO_OWNER, message: 'Domínio sem responsável', severity: 'CRITICAL' },
  NO_STEWARD: { code: PENDENCY_CODE.NO_STEWARD, message: 'Domínio sem steward', severity: 'HIGH' },
});

const person = (row) => ({ userId: row.user_id, name: row.user_name, since: row.valid_from instanceof Date ? row.valid_from.toISOString() : row.valid_from });

/** Monta a visão de cada domínio (na ordem do parâmetro) a partir das designações vigentes. */
function buildDomainViews(codes, assignments) {
  return codes.map((code) => {
    const mine = assignments.filter((row) => row.code === code);
    const owner = mine.find((row) => row.role === 'OWNER');
    const stewards = mine.filter((row) => row.role === 'STEWARD').map(person);
    const pendencies = [];
    if (!owner) pendencies.push({ ...PENDENCY.NO_OWNER });
    if (!stewards.length) pendencies.push({ ...PENDENCY.NO_STEWARD });
    return { code, owner: owner ? person(owner) : null, stewards, pendencies };
  });
}

module.exports = { PENDENCY, buildDomainViews };
