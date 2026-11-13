'use strict';

const { LegalDeadline } = require('../../../../../models');
const { createLegalDeadline, updateLegalDeadline } = require('../../../../../modules/legal/cases/deadline.service');
const { resolveRef } = require('../refs');
const { parseOccurredAt } = require('../../bcp.time');
const { commandRejected } = require('../../bcp.errors');
const normalize = require('../normalize');

/**
 * REGISTER_DEADLINE: o prazo ou intimação do papel vira prazo jurídico do processo pelo serviço normal (vence no fim do dia da data final, em Brasília; o responsável é quem
 * importa; a origem rastreável é o número do formulário). Confere processo e data final.
 */
async function execute({ tenant, actorUserId, operation, payload, transaction }) {
  const legalCase = await resolveRef('legalCase', payload.processo, tenant, transaction);
  const dueAt = parseOccurredAt(`${payload.dataFinalPrazo}T23:59`);
  if (!dueAt) throw commandRejected('a data final do prazo é inválida');
  const kind = payload.tipo === 'INTIMACAO' ? 'Intimação' : 'Prazo';
  const deadline = await createLegalDeadline(legalCase.id, {
    description: `${kind}: ${payload.descricao}`.slice(0, 500), dueAt, responsibleUserId: actorUserId,
    sourceDocument: `Formulário contingencial ${operation.manualReference} (ciência em ${payload.dataCiencia}; conferido por ${payload.conferidoPor})`.slice(0, 500),
  }, actorUserId, transaction, { contingencyOrigin: true }); // Guia §12: na contingência a origem é o formulário registrado na operação do BCP
  const saved = await LegalDeadline.findByPk(deadline.id, { transaction });
  return {
    commandRef: `LegalDeadline:${saved.id}`,
    undo: { deadlineId: saved.id },
    comparisons: [
      { field: 'processo', label: 'Processo', paper: normalize.id(legalCase.id), command: normalize.id(saved.legalCaseId), kind: 'ref' },
      { field: 'dataFinalPrazo', label: 'Data final do prazo', paper: normalize.day(payload.dataFinalPrazo), command: normalize.day(saved.dueAt), kind: 'date' },
    ],
  };
}

/** Estorno: o prazo é cancelado pelo serviço normal (o calendário acompanha pelo evento do serviço). */
async function reverse({ actorUserId, effect, operation, transaction }) {
  await updateLegalDeadline(effect.deadlineId, { status: 'CANCELLED', conclusionNote: `Estorno da operação manual ${operation.manualReference} (BCP).` }, actorUserId, transaction);
}

module.exports = { action: 'REGISTER_DEADLINE', execute, reverse };
