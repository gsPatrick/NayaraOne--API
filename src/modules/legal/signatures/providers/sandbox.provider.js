'use strict';

const crypto = require('crypto');

/**
 * SignatureAdapter — contrato de integração com provedores de assinatura eletrônica.
 *
 * Este arquivo define apenas o `SandboxSignatureAdapter`: um mock local que NÃO faz nenhuma
 * chamada HTTP real. Ele existe para permitir o fluxo completo de negócio (iniciar
 * assinatura, receber "webhook") ser testado e usado em desenvolvimento sem depender de
 * credenciais de provedor real.
 *
 * Em produção, um adapter real (ex.: `ClicksignSignatureAdapter`, `ZapSignSignatureAdapter`)
 * implementaria a mesma interface (`requestSignature(contractVersion, signers)`) usando
 * credenciais vindas de variáveis de ambiente (ex.: CLICKSIGN_API_TOKEN, ZAPSIGN_API_TOKEN —
 * ainda não configuradas neste projeto) e faria as chamadas HTTP reais ao provedor, retornando
 * o `externalSignatureId` real emitido por ele. A troca de adapter seria feita por
 * configuração (ex.: SIGNATURE_PROVIDER=clicksign|zapsign|sandbox), nunca alterando o código
 * de signatures.service.js — só a implementação injetada.
 */
class SandboxSignatureAdapter {
  /**
   * requestSignature — "envia" a versão do contrato para assinatura de uma lista de
   * signatários. Retorna um mapa personId -> externalSignatureId (fake, gerado localmente).
   * Não persiste nada e não faz I/O — a persistência de Signature é responsabilidade do
   * chamador (signatures.service.js).
   */
  async requestSignature(contractVersion, signerPersonIds, _transaction) {
    const externalSignatureIdsByPerson = {};
    for (const personId of signerPersonIds) {
      externalSignatureIdsByPerson[personId] = `sandbox-sig-${crypto.randomUUID()}`;
    }
    return {
      providerEnvelopeId: `sandbox-envelope-${crypto.randomUUID()}`,
      externalSignatureIdsByPerson,
    };
  }

  // Sandbox não tem provedor real por trás — "consulta de status" sempre responde "pendente"
  // (nunca finaliza sozinho; a confirmação em sandbox vem de handleSignatureWebhook simulado).
  async getStatus(providerEnvelopeId) {
    return { providerEnvelopeId, status: 'PENDING', raw: null };
  }

  // Sandbox aceita cancelamento sempre (não há efeito colateral externo a desfazer).
  async cancel(providerEnvelopeId) {
    return { providerEnvelopeId, cancelled: true, raw: null };
  }

  // Sandbox nunca tem um documento assinado de verdade por trás (não existe provedor real) —
  // retorna null explicitamente em vez de inventar um PDF. handleEnvelopeClosedWebhook trata
  // `null` como "nada pra baixar" e não falha por isso.
  async downloadSignedDocument(_providerEnvelopeId) {
    return null;
  }
}

module.exports = { SandboxSignatureAdapter };
