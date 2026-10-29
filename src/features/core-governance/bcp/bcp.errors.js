'use strict';

const { govError } = require('../governance.errors');

/** Erros do BCP (M9-D831 §4): códigos GOV_BCP_*, mensagens em português. */
const referenceDuplicate = () => govError(409, 'GOV_BCP_REFERENCE_DUPLICATE', 'Este número de formulário já foi registrado.');
const referenceInvalid = () => govError(422, 'GOV_BCP_REFERENCE_INVALID', 'O número do formulário é inválido para este setor.');
const evidenceRequired = () => govError(422, 'GOV_BCP_EVIDENCE_REQUIRED', 'Anexe a foto ou o escaneamento do formulário.');
const actionInvalid = () => govError(422, 'GOV_BCP_ACTION_INVALID', 'Esta ação não existe para o setor.');
const notEditable = () => govError(409, 'GOV_BCP_NOT_EDITABLE', 'Esta operação já foi importada e não pode ser editada.');
const sectorForbidden = (verb = 'registrar operações') => govError(403, 'GOV_BCP_SECTOR_FORBIDDEN', `Você não pode ${verb} deste setor.`);
const dateInvalid = () => govError(422, 'GOV_BCP_DATE_INVALID', 'A data da operação é inválida.');
const payloadInvalid = (errors) => govError(422, 'GOV_BCP_PAYLOAD_INVALID', 'Os dados do formulário não passam nas regras do sistema.', { errors });
const formNotFound = () => govError(404, 'GOV_BCP_FORM_NOT_FOUND', 'Formulário não encontrado para este setor.');
const rangeInvalid = (max) => govError(400, 'GOV_BCP_RANGE_INVALID', `A faixa de folhas é inválida (máximo de ${max}).`);
const alreadyFinal = () => govError(409, 'GOV_BCP_ALREADY_FINAL', 'Esta operação já foi concluída.');
const commandRejected = (reason) => govError(422, 'GOV_BCP_COMMAND_REJECTED', `O sistema recusou a operação: ${String(reason || 'motivo não informado').replace(/\.+\s*$/u, '')}.`, { reason });
const decisionNoteRequired = () => govError(400, 'GOV_BCP_DECISION_NOTE_REQUIRED', 'Informe a justificativa da decisão.');
const paymentDoubleCheck = () => govError(422, 'GOV_BCP_PAYMENT_DOUBLE_CHECK', 'Pagamento manual exige conferência por duas pessoas diferentes.');
const paymentSamePerson = () => govError(403, 'GOV_BCP_PAYMENT_SAME_PERSON', 'As duas conferências devem ser de pessoas diferentes.');
const permissionMissing = (code) => govError(403, 'PERMISSION_DENIED', `Permissão ausente: ${code}.`);

module.exports = { paymentDoubleCheck, paymentSamePerson, permissionMissing, alreadyFinal, commandRejected, decisionNoteRequired, formNotFound, rangeInvalid, referenceDuplicate, referenceInvalid, evidenceRequired, actionInvalid, notEditable, sectorForbidden, dateInvalid, payloadInvalid };
