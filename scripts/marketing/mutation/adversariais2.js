'use strict';

// Mutações dos testes adversariais 9 a 15 (M9-D437): cada uma desfaz a proteção da dona e o teste nomeado correspondente TEM de reprovar. Texto exato do código de produção.
const S = 'src/features/marketing';
const T = 'test/marco9/marketing/adversarial';

module.exports = [
  { id: 'adv_09a', teste: `${T}/adv_09_cross_company_audience_bloqueado.test.js`, descricao: 'a audiência deixa de conferir se as pessoas são da empresa', edicoes: [
    { arquivo: `${S}/campaigns/audience.service.js`, de: 'if (visible !== ids.length) throw crossCompany(', para: 'if (false) throw crossCompany(' },
  ] },
  { id: 'adv_09b', teste: `${T}/adv_09_cross_company_audience_bloqueado.test.js`, descricao: 'o filtro com a empresa de outro tenant passa', edicoes: [
    { arquivo: `${S}/campaigns/audience.service.js`, de: 'if (audience.claimedCompanyId && audience.claimedCompanyId.toLowerCase()', para: 'if (false && audience.claimedCompanyId && audience.claimedCompanyId.toLowerCase()' },
  ] },
  { id: 'adv_10', teste: `${T}/adv_10_tracking_invalido_nao_atribui_venda.test.js`, descricao: 'o clique deixa de conferir a assinatura do link', edicoes: [
    { arquivo: `${S}/tracking/tracking.redirect.service.js`, de: ' || !(await signing.verifyLink(routing.company_id, link))', para: '' },
  ] },
  { id: 'adv_11a', teste: `${T}/adv_11_conta_social_token_vazado_secret_redaction.test.js`, descricao: 'o resultado do worker grava o texto do provedor sem varrer segredo', edicoes: [
    { arquivo: `${S}/publications/worker/worker.results.js`, de: 'response: JSON.stringify(redactResponse(response)), actor,', para: 'response: JSON.stringify(response), actor,' },
  ] },
  { id: 'adv_11b', teste: `${T}/adv_11_conta_social_token_vazado_secret_redaction.test.js`, descricao: 'o AUTH_REVOKED do provedor deixa de acionar o comprometimento', edicoes: [
    { arquivo: `${S}/publications/worker/worker.outcome.js`, de: 'if (security.isAuthRevoked(error)) await', para: 'if (false) await' },
    { arquivo: `${S}/publications/adapters/sendToChannel.js`, de: 'if (security.isAuthRevoked(result.error)) await', para: 'if (false) await' },
  ] },
  { id: 'adv_12', teste: `${T}/adv_12_cliente_negativo_abre_ocorrencia_antes_de_review_request.test.js`, descricao: 'a nota negativa deixa de ser classificada como negativa', edicoes: [
    { arquivo: `${S}/automations/reviews/review.classify.js`, de: "if (n <= maxNegative) return 'NEGATIVE';", para: '' },
  ] },
  { id: 'adv_13a', teste: `${T}/adv_13_endereco_restrito_payload_publico_sanitizado.test.js`, descricao: 'a segunda barreira entrega o payload sem sanitizar', edicoes: [
    { arquivo: `${S}/content/adapterGate.js`, de: 'await adapter[method](report.payload)', para: 'await adapter[method](payload)' },
  ] },
  { id: 'adv_13b', teste: `${T}/adv_13_endereco_restrito_payload_publico_sanitizado.test.js`, descricao: 'a política SO_BAIRRO deixa rua e número no payload', edicoes: [
    { arquivo: `${S}/content/sanitize.js`, de: "SO_BAIRRO: ['logradouro', 'numeroEndereco']", para: 'SO_BAIRRO: []' },
  ] },
  { id: 'adv_14', teste: `${T}/adv_14_campanha_encerrada_steps_nao_continuam.test.js`, descricao: 'a porta do runner aceita campanha que não está RUNNING', edicoes: [
    { arquivo: `${S}/campaigns/runnerGuard.js`, de: "if (!row || row.status !== 'RUNNING') return", para: "if (!row) return" },
  ] },
  { id: 'adv_15', teste: `${T}/adv_15_prompt_injection_em_descricao_nao_altera_policy.test.js`, descricao: 'o validador factual deixa de apontar instrução suspeita no cadastro', edicoes: [
    { arquivo: `${S}/content/factual/injection.js`, de: 'if (!sentence) continue;', para: 'continue;' },
  ] },
];
