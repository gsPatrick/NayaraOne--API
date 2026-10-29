'use strict';

// Apoio dos testes M9-D832 (não é teste): o corpo válido de cada uma das 11 ações, apontando para as entidades criadas por m9d832Base e m9d832More.
const { uniqueCpf } = require('./exportsEnv');
const { SPEC } = require('./m9d834Spec');

const PREFIX = { ATENDIMENTO: 'ATD', LOCACAO: 'LOC', FINANCEIRO: 'FIN', OBRAS: 'OBR', CORRESPONDENTE: 'COR', JURIDICO: 'JUR' };
let counter = 0;
/** Telefone novo a cada chamada (8 dígitos sorteados + DDD 11 e 9): execuções repetidas no mesmo banco não reaproveitam a pessoa de uma execução anterior. */
const phone = () => `119${String(require('node:crypto').randomInt(0, 100000000)).padStart(8, '0')}`;
/** Dia único (2027-01-01 em diante) para não colidir com um diário já gravado nas execuções anteriores no mesmo banco. */
const freshDay = () => { counter += 1; return new Date(Date.UTC(2027, 0, 1) + (Date.now() % 300) * 86400000 + counter * 86400000).toISOString().slice(0, 10); };

/** payload por ação; `ctx` = { base, receivableId, legalCaseId, financingCaseId }. */
const PAYLOADS = {
  REGISTER_LEAD: () => ({ nome: 'Lead QA da Silva', telefone: phone(), interesse: 'LOCACAO', origem: 'WhatsApp' }),
  REGISTER_VISIT: ({ base }) => ({ nomeCliente: 'Cliente Visita QA', telefone: phone(), imovel: base.property.id, dataHoraVisita: '2026-10-20T10:00', corretor: 'Corretor QA' }),
  REGISTER_PROPOSAL: ({ base }) => ({ proponente: 'Proponente QA', documento: uniqueCpf(), imovel: base.property.id, valorAluguelCentavos: 250000, prazoMeses: 30, garantia: 'Fiador' }),
  REGISTER_KEY_DELIVERY: ({ base }) => ({ contrato: base.contract.id, imovel: base.property.id, recebedor: base.lessee.name, documentoRecebedor: base.lessee.cpf, quantidadeChaves: 2, data: '2026-10-20' }),
  RECEIVE_PAYMENT: ({ base, receivableId }) => ({ pagador: base.lessee.name, documento: base.lessee.cpf, valorCentavos: 120500, forma: 'PIX', data: '2026-10-20', referenciaParcela: receivableId, comprovanteAnexado: 'SIM' }),
  EMERGENCY_PAYMENT: ({ base }) => ({
    favorecido: 'Fornecedor QA', documento: uniqueCpf(), contaOuChavePix: 'pix-qa@exemplo.com', valorCentavos: 350000, motivoUrgencia: 'Concretagem', centroCusto: base.costCenter.id, comprovanteObrigacao: 'SIM',
    conferente1: 'Ana QA', conferente1DataHora: '2026-10-20T10:00', conferente2: 'Bruno QA', conferente2DataHora: '2026-10-20T10:05',
  }),
  DAILY_REPORT: ({ base }) => ({ obra: base.project.id, data: freshDay(), equipePresente: '5 pessoas', servicosExecutados: 'Alvenaria do pavimento 1', fotosQuantidade: 3 }),
  MATERIAL_REQUEST: ({ base }) => ({ obra: base.project.id, material: 'Cimento CP-II', quantidade: 10, unidade: 'saco', urgencia: 'ALTA', solicitante: 'Mestre QA' }),
  REGISTER_DOCUMENT: ({ financingCaseId }) => ({ processo: financingCaseId, tipoDocumento: 'RG e CPF', entreguePor: 'Cliente QA', recebidoPor: 'Atendente QA', data: '2026-10-20', classificacao: 'Restrito' }),
  REGISTER_CASE_PROGRESS: ({ financingCaseId }) => ({ processo: financingCaseId, etapa: 'Em análise', situacao: 'Aguardando parecer do banco', data: '2026-10-20' }),
  REGISTER_DEADLINE: ({ legalCaseId }) => ({ processo: legalCaseId, tipo: 'PRAZO', dataCiencia: '2026-10-20', dataFinalPrazo: '2026-11-10', descricao: 'Contestação', conferidoPor: 'Dra. QA' }),
};

/** Sobrescrita para `env.record`: setor, número novo, tipo, ação e payload da ação. */
function operationFor(action, ctx, payloadOver = {}, reference) {
  const spec = SPEC.find((item) => item.action === action);
  const env = require('./bcpEnv');
  return { sector: spec.sector, manualReference: reference || env.reference(PREFIX[spec.sector]), formType: spec.formType, intendedAction: action, payload: { ...PAYLOADS[action](ctx), ...payloadOver } };
}

module.exports = { PAYLOADS, operationFor, PREFIX, phone };
