'use strict';

const AppError = require('../../../utils/AppError');

/** Erros de negócio da publicação em redes sociais (M9-D239 seção 4), todos com a mensagem do livro em português. */
const contentNotFound = () => AppError.notFound('Conteúdo não encontrado.', 'INTEGRATION_SOCIAL_CONTENT_NOT_FOUND');
const contentNotApproved = (details) => AppError.forbidden('Este conteúdo ainda não foi aprovado para publicação.', 'INTEGRATION_SOCIAL_CONTENT_NOT_APPROVED', details);
const changedAfterApproval = (details) => AppError.conflict('O conteúdo mudou após a aprovação; aprove novamente.', 'INTEGRATION_SOCIAL_CONTENT_CHANGED_AFTER_APPROVAL', details);
const autoPublishDisabled = () => AppError.forbidden('A publicação automática não está habilitada.', 'INTEGRATION_SOCIAL_AUTO_PUBLISH_DISABLED');
const killSwitchActive = () => AppError.forbidden('O kill switch do Marketing está ativo: nenhuma publicação sai até a reativação.', 'INTEGRATION_SOCIAL_KILL_SWITCH_ACTIVE');
const rescheduleNotAllowed = () => AppError.conflict('Esta publicação já saiu ou está em andamento: cancele-a explicitamente antes de agendar outra.', 'INTEGRATION_SOCIAL_RESCHEDULE_NOT_ALLOWED');
const scheduleInvalid = () => AppError.unprocessable('Informe uma data de agendamento válida.', 'INTEGRATION_SOCIAL_SCHEDULE_INVALID');
const noNetwork = () => AppError.unprocessable('Informe ao menos uma rede para publicar.', 'INTEGRATION_SOCIAL_NETWORK_REQUIRED');

module.exports = {
  contentNotFound, contentNotApproved, changedAfterApproval, autoPublishDisabled, killSwitchActive, rescheduleNotAllowed, scheduleInvalid, noNetwork,
};
