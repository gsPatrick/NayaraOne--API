'use strict';

// Mutações dos 8 testes adversariais (M9-D436): cada uma desfaz a proteção da dona e o teste nomeado correspondente TEM de reprovar. Texto exato do código de produção.
const S = 'src/features/marketing';
const T = 'test/marco9/marketing/adversarial';

module.exports = [
  { id: 'adv_01', teste: `${T}/adv_01_opt_out_recebe_automacao_bloqueado.test.js`, descricao: 'canSend deixa de barrar a supressão e o opt-out', edicoes: [
    { arquivo: `${S}/suppression/canSend.js`, de: "if (suppression) return blocked('SUPPRESSED', { suppressionId: suppression.id });", para: '' },
    { arquivo: `${S}/suppression/canSend.js`, de: "if (consent && consent.status === 'OPT_OUT') return blocked('OPT_OUT');", para: '' },
  ] },
  { id: 'adv_02a', teste: `${T}/adv_02_mesmo_evento_2x_uma_mensagem_ou_post.test.js`, descricao: 'a chave da run passa a ser diferente a cada chamada', edicoes: [
    { arquivo: `${S}/automations/idempotency.keys.js`, de: "${subjectId == null ? '' : subjectId}`);\n}\n\nfunction actionKey", para: "${subjectId == null ? '' : subjectId}:${Math.random()}`);\n}\n\nfunction actionKey" },
  ] },
  { id: 'adv_02b', teste: `${T}/adv_02_mesmo_evento_2x_uma_mensagem_ou_post.test.js`, descricao: 'o agendamento deixa de reaproveitar o job da mesma chave', edicoes: [
    { arquivo: `${S}/publications/schedule/schedule.jobs.js`, de: 'AND idempotency_key = :key AND deleted_at IS NULL`', para: "AND idempotency_key = :key AND deleted_at IS NULL AND false`" },
  ] },
  { id: 'adv_03', teste: `${T}/adv_03_imovel_sem_dado_ia_nao_inventa.test.js`, descricao: 'o validador factual deixa de apontar dado inexistente', edicoes: [
    { arquivo: `${S}/content/factual/finding.js`, de: 'if (!hasData) return finding(', para: 'if (false) return finding(' },
  ] },
  { id: 'adv_04', teste: `${T}/adv_04_ocorrencia_interna_nao_entra_em_conteudo.test.js`, descricao: 'a segunda barreira entrega o payload sem sanitizar', edicoes: [
    { arquivo: `${S}/content/adapterGate.js`, de: 'await adapter[method](report.payload)', para: 'await adapter[method](payload)' },
  ] },
  { id: 'adv_05a', teste: `${T}/adv_05_template_muda_apos_approval_invalida.test.js`, descricao: 'a aprovação nunca é considerada invalidada ao agendar', edicoes: [
    { arquivo: `${S}/content/approval.guard.js`, de: 'if (version && version.approved_hash && version.approved_hash === expected) {', para: 'if (version) {' },
  ] },
  { id: 'adv_05b', teste: `${T}/adv_05_template_muda_apos_approval_invalida.test.js`, descricao: 'o worker deixa de conferir a versão corrente e o hash aprovado', edicoes: [
    { arquivo: `${S}/publications/worker/worker.content.js`, de: "if (content.current_version_id !== job.content_version_id) return { ok: false, reason: 'VERSION_SUPERSEDED', content };", para: '' },
  ] },
  { id: 'adv_06', teste: `${T}/adv_06_frequency_cap_excedido_bloqueia.test.js`, descricao: 'o frequency cap nunca bloqueia', edicoes: [
    { arquivo: `${S}/automations/frequency.js`, de: 'if (blocking.length === 0) return', para: 'if (true) return' },
  ] },
  { id: 'adv_07', teste: `${T}/adv_07_kill_switch_ativo_nenhuma_acao_outbound.test.js`, descricao: 'o kill switch nunca bloqueia', edicoes: [
    { arquivo: `${S}/killswitch.state.js`, de: 'return { blocked: active.length > 0, unreadable: false, active };', para: 'return { blocked: false, unreadable: false, active: [] };' },
  ] },
  { id: 'adv_08', teste: `${T}/adv_08_provider_timeout_nao_duplica_post.test.js`, descricao: 'o timeout volta o job a PENDING (retry cego) em vez de UNKNOWN', edicoes: [
    { arquivo: `${S}/publications/worker/worker.outcome.js`, de: "{ status: 'UNKNOWN', unknownSince: ctx.now, nextCheckAt: ctx.now,", para: "{ status: 'PENDING', unknownSince: ctx.now, nextCheckAt: ctx.now," },
  ] },
];
