'use strict';

// Violações das 8 guardas "Não improvisar" (M9-D440): cada uma injeta, numa cópia, o atalho que o livro proíbe. A guarda nomeada TEM de reprovar (a estática lê a cópia; o teste da guarda roda na cópia).
// Texto exato do código de produção. `guarda` é o nome do livro; `teste` é o arquivo da guarda.
const S = 'src/features/marketing';
const T = 'test/marco9/marketing/guards';

module.exports = [
  { id: 'g1_literal', guarda: 'guard_no_hardcoded_cadence', teste: `${T}/guard_no_hardcoded_cadence.test.js`, descricao: 'um atraso de 3 dias escrito no código (delay = 3 * 86400)', edicoes: [
    { arquivo: `${S}/automations/violacao.cadencia.js`, criar: "'use strict';\n\nconst delay = 3 * 86400;\nmodule.exports = { delay };\n" },
  ] },
  { id: 'g1_lista', guarda: 'guard_no_hardcoded_cadence', teste: `${T}/guard_no_hardcoded_cadence.test.js`, descricao: 'a lista de dias de cadência escrita no código', edicoes: [
    { arquivo: `${S}/automations/violacao.lista.js`, criar: "'use strict';\n\nmodule.exports = { dias: [3, 30, 90, 365] };\n" },
  ] },
  { id: 'g1_seed', guarda: 'guard_no_hardcoded_cadence', teste: `${T}/guard_no_hardcoded_cadence.test.js`, descricao: 'a automação pronta volta a levar o cap 3 em 7 dias escrito no código', edicoes: [
    { arquivo: `${S}/automations/seeds/posChaves.js`, de: 'frequencyCap: await seedFrequencyCap(tenant, transaction)', para: "frequencyCap: { max: 3, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' }" },
  ] },
  { id: 'g2_direta', guarda: 'guard_send_requires_cansend', teste: `${T}/guard_send_requires_cansend.test.js`, descricao: 'um arquivo novo chama o canal direto, sem o wrapper com canSend', edicoes: [
    { arquivo: `${S}/campaigns/violacao.envio.js`, criar: "'use strict';\n\nconst { sendToChannel } = require('../publications/adapters/sendToChannel');\n\nmodule.exports = (ctx) => sendToChannel('WHATSAPP', { to: 'x', text: 'y' }, ctx);\n" },
  ] },
  { id: 'g2_sem_cansend', guarda: 'guard_send_requires_cansend', teste: `${T}/guard_send_requires_cansend.test.js`, descricao: 'o wrapper deixa de consultar o canSend antes do canal', edicoes: [
    { arquivo: `${S}/publications/messaging/message/message.send.js`, de: 'const decision = await canSend(input.personId, input.channel,', para: 'const decision = await Promise.resolve({ allowed: true }) || (input.personId, input.channel,' },
  ] },
  { id: 'g2_reenvio_sem_cansend', guarda: 'guard_send_requires_cansend', teste: `${T}/guard_send_requires_cansend.test.js`, descricao: 'o reenvio da fila (DI-M9F-2) deixa de consultar o canSend antes do canal', edicoes: [
    { arquivo: `${S}/publications/messaging/message/message.send.js`, de: 'const decision = await canSend(input.personId, row.channel,', para: 'const decision = await Promise.resolve({ allowed: true }) || (input.personId, row.channel,' },
  ] },
  { id: 'g3_pula_factual', guarda: 'guard_ai_output_requires_factual_validation', teste: `${T}/guard_ai_output_requires_factual_validation.test.js`, descricao: 'o passo de marca deixa de exigir a validação factual', edicoes: [
    { arquivo: `${S}/content/pipeline.core.js`, de: "branding: { from: 'FACT_CHECKED', to: 'BRANDED', prereq: 'factual' }", para: "branding: { from: 'FACT_CHECKED', to: 'BRANDED', prereq: 'facts' }" },
  ] },
  { id: 'g4_dto_bruto', guarda: 'guard_public_payload_only', teste: `${T}/guard_public_payload_only.test.js`, descricao: 'a porta de saída deixa de exigir PublicPayload nos canais de publicação', edicoes: [
    { arquivo: `${S}/publications/adapters/sendToChannel.js`, de: "if (CHANNEL_META[channel].operation === 'publish') assertPublicPayload(message, channel);", para: '' },
  ] },
  { id: 'g5_retry_cego', guarda: 'guard_no_blind_retry', teste: `${T}/guard_no_blind_retry.test.js`, descricao: 'o timeout volta o job a PENDING sem consultar o canal', edicoes: [
    { arquivo: `${S}/publications/worker/worker.outcome.js`, de: "{ status: 'UNKNOWN', unknownSince: ctx.now, nextCheckAt: ctx.now,", para: "{ status: 'PENDING', unknownSince: ctx.now, nextCheckAt: ctx.now," },
  ] },
  { id: 'g6_sem_kill', guarda: 'guard_kill_switch_always_checked', teste: `${T}/guard_kill_switch_always_checked.test.js`, descricao: 'o runner deixa de consultar o kill switch', edicoes: [
    { arquivo: `${S}/automations/runner/runner.decide.js`, de: 'await isOutboundBlocked(', para: 'await Promise.resolve({ blocked: false, blockedBy: [] }) || (' },
  ] },
  { id: 'g7_sem_ocorrencia', guarda: 'guard_review_after_case_resolved', teste: `${T}/guard_review_after_case_resolved.test.js`, descricao: 'o pedido de avaliação deixa de conferir ocorrência aberta', edicoes: [
    { arquivo: `${S}/automations/reviews/review.positive.js`, de: 'if (await repo.hasOpenCase(input.personId, input.transaction)) return { reviewRequestId: null', para: 'if (false) return { reviewRequestId: null' },
  ] },
  { id: 'g8_sem_chave', guarda: 'guard_replay_is_safe', teste: `${T}/guard_replay_is_safe.test.js`, descricao: 'o agendamento deixa de reaproveitar o job da mesma chave', edicoes: [
    { arquivo: `${S}/publications/schedule/schedule.jobs.js`, de: 'AND idempotency_key = :key AND deleted_at IS NULL`', para: 'AND idempotency_key <> :key AND deleted_at IS NULL`' },
  ] },
];
