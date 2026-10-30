'use strict';

/**
 * Objeto antigo duplo dos provedores de assinatura reais (Clicksign e ZapSign) para a suíte de contrato (M9-D236 + M9-D222): a mesma interface dos adapters antigos
 * (requestSignature, getStatus, cancel, downloadSignedDocument), determinístico e sem rede ou credencial. `meta()` entrega a versão do contrato de mentira que o adapter lê
 * do banco no envio real (a suíte de contrato não abre conexão de banco; a leitura real é provada nos testes da M9-D236).
 */
function makeSignatureDouble() {
  return {
    async requestSignature(versao, personIds) {
      const porPessoa = {};
      personIds.forEach((id) => { porPessoa[id] = `assinante-contrato-${id}`; });
      return { providerEnvelopeId: `envelope-contrato-${versao.id}`, externalSignatureIdsByPerson: porPessoa };
    },
    async getStatus(providerEnvelopeId) {
      return { providerEnvelopeId, status: 'PENDING', raw: { sandbox: true } };
    },
    async cancel(providerEnvelopeId) {
      return { providerEnvelopeId, cancelled: true, raw: { sandbox: true } };
    },
    async downloadSignedDocument() {
      return { buffer: Buffer.from('%PDF-contrato'), fileName: 'contrato-assinado.pdf' };
    },
  };
}

const signatureMeta = () => ({
  transaction: { contrato: true },
  loadContractVersion: async (id) => ({ id, contentHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }),
});

module.exports = { makeSignatureDouble, signatureMeta };
