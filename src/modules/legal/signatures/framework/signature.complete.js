'use strict';

const { Signature, SignatureEnvelope, ContractVersion, ContractParty } = require('../../../../models');
const contractsService = require('../../contracts/application/contract.service');
const { readSignatureParams } = require('./signature.params');
const { countingSignatures } = require('../signatureRows');

/**
 * Portão da evidência (M9-D236 3.2 item 4): o contrato só vai a SIGNED com TODAS as assinaturas eletrônicas com evidência completa e, quando elas pertencem a um envelope
 * de fornecedor, com o envelope SIGNED (arquivo assinado recebido e hash do original conferido). Assinatura manual (MANUAL_UPLOAD) também exige a evidência completa e a simulada do
 * sandbox (fora de produção) traz evidência marcada como simulada. `legal.assinatura.exigir_evidencia_completa` desligado libera o portão (laboratório).
 */
async function evidenceGate(tenant, signatures, transaction) {
  const params = await readSignatureParams(tenant, transaction);
  if (!params.exigirEvidencia) return true;
  for (const s of signatures) {
    if (!s.evidenceComplete) return false; // inclusive a manual (MANUAL_UPLOAD, M9-D227): o arquivo assinado com hash e o hash do documento da versão
    if (s.signatureMethod !== 'MANUAL' && s.envelopeId && !(s.evidenceJson && s.evidenceJson.simulated)) {
      const envelope = await SignatureEnvelope.findByPk(s.envelopeId, { transaction });
      // SUPERSEDED: quem assinou antes da troca de fornecedor (M9-D227) mantém a evidência própria; o envelope antigo foi substituído
      if (envelope && !['SIGNED', 'SUPERSEDED'].includes(envelope.status)) return false;
    }
  }
  return true;
}

/**
 * Leva o contrato a SIGNED quando todas as assinaturas pedidas estão SIGNED, cada papel obrigatório do tipo do contrato tem ao menos uma assinatura SIGNED (JUR M5-09)
 * e o portão da evidência passa. Devolve true quando transicionou.
 */
async function tryCompleteContract(contractVersionId, transaction) {
  const assinaturas = countingSignatures(await Signature.findAll({ where: { contractVersionId }, transaction }));
  if (assinaturas.length === 0 || !assinaturas.every((s) => s.status === 'SIGNED')) return false;
  const versao = await ContractVersion.findByPk(contractVersionId, { transaction });
  const contract = await contractsService.getContract(versao.contractId, transaction);
  if (contract.status !== 'SIGNING') return false;
  const papeis = contractsService.REQUIRED_ROLES_BY_TYPE[contract.contractType] || [];
  if (papeis.length > 0) {
    const partes = await ContractParty.findAll({ where: { contractId: contract.id }, transaction });
    const assinaram = new Set(assinaturas.filter((s) => s.status === 'SIGNED').map((s) => s.personId));
    if (!papeis.every((papel) => partes.some((p) => p.partyRole === papel && assinaram.has(p.personId)))) return false;
  }
  if (!(await evidenceGate({ groupId: contract.groupId, companyId: contract.companyId }, assinaturas, transaction))) return false;
  await contractsService.transitionContractStatus(contract, 'SIGNED', null, transaction);
  return true;
}

module.exports = { evidenceGate, tryCompleteContract };
