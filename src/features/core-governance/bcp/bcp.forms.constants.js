'use strict';

/**
 * Os 11 formulários contingenciais dos seis setores (M9-D834 §3.2): setor, tipo, ação pretendida (fixa pelo tipo) e os campos próprios. Campo = [chave, tipo, obrigatório]. Tipos:
 * TEXT, INTEGER, CENTS (inteiro em centavos), DATE (AAAA-MM-DD), DATETIME (ISO), ENUM, PERSON_DOC (CPF/CNPJ), PHONE, REF. O cabeçalho do papel (número, setor, tipo, data e hora,
 * nome de quem preencheu, assinatura) é do papel e do registro, não do payload. M9-D831 valida o payload por este catálogo; M9-D834 publica o mesmo conteúdo como modelo imprimível.
 */
const CANAL = ['DINHEIRO', 'PIX', 'TRANSFERENCIA', 'CHEQUE'];
const SIM_NAO = ['SIM', 'NAO'];

const FORMS = Object.freeze([
  { sector: 'ATENDIMENTO', formType: 'LEAD_ATENDIMENTO', action: 'REGISTER_LEAD', fields: [
    ['nome', 'TEXT', true], ['telefone', 'PHONE', true], ['email', 'TEXT', false], ['interesse', 'ENUM', true, ['COMPRA', 'LOCACAO', 'VENDA']],
    ['imovelInteresse', 'TEXT', false], ['origem', 'TEXT', true], ['observacao', 'TEXT', false]] },
  { sector: 'ATENDIMENTO', formType: 'REGISTRO_VISITA', action: 'REGISTER_VISIT', fields: [
    ['nomeCliente', 'TEXT', true], ['telefone', 'PHONE', true], ['imovel', 'REF', true], ['dataHoraVisita', 'DATETIME', true], ['corretor', 'TEXT', true], ['observacao', 'TEXT', false]] },
  { sector: 'LOCACAO', formType: 'PROPOSTA_LOCACAO', action: 'REGISTER_PROPOSAL', fields: [
    ['proponente', 'TEXT', true], ['documento', 'PERSON_DOC', true], ['imovel', 'REF', true], ['valorAluguelCentavos', 'CENTS', true], ['prazoMeses', 'INTEGER', true],
    ['garantia', 'TEXT', true], ['observacao', 'TEXT', false]] },
  { sector: 'LOCACAO', formType: 'ENTREGA_CHAVE', action: 'REGISTER_KEY_DELIVERY', fields: [
    ['contrato', 'REF', true], ['imovel', 'REF', true], ['recebedor', 'TEXT', true], ['documentoRecebedor', 'PERSON_DOC', true], ['quantidadeChaves', 'INTEGER', true],
    ['data', 'DATE', true], ['estadoImovel', 'TEXT', false]] },
  { sector: 'FINANCEIRO', formType: 'RECEBIMENTO', action: 'RECEIVE_PAYMENT', fields: [
    ['pagador', 'TEXT', true], ['documento', 'PERSON_DOC', true], ['valorCentavos', 'CENTS', true], ['forma', 'ENUM', true, CANAL], ['data', 'DATE', true],
    ['referenciaParcela', 'REF', true], ['comprovanteAnexado', 'ENUM', true, SIM_NAO]] },
  { sector: 'FINANCEIRO', formType: 'PAGAMENTO_EMERGENCIAL', action: 'EMERGENCY_PAYMENT', fields: [
    ['favorecido', 'TEXT', true], ['documento', 'PERSON_DOC', true], ['contaOuChavePix', 'TEXT', true], ['valorCentavos', 'CENTS', true], ['motivoUrgencia', 'TEXT', true],
    ['centroCusto', 'REF', true], ['comprovanteObrigacao', 'ENUM', true, SIM_NAO], ['conferente1', 'TEXT', true], ['conferente1DataHora', 'DATETIME', true],
    ['conferente2', 'TEXT', true], ['conferente2DataHora', 'DATETIME', true]] },
  { sector: 'OBRAS', formType: 'DIARIO_OBRA', action: 'DAILY_REPORT', fields: [
    ['obra', 'REF', true], ['data', 'DATE', true], ['clima', 'TEXT', false], ['equipePresente', 'TEXT', true], ['servicosExecutados', 'TEXT', true], ['ocorrencias', 'TEXT', false],
    ['fotosQuantidade', 'INTEGER', true]] },
  { sector: 'OBRAS', formType: 'REQUISICAO_MATERIAL', action: 'MATERIAL_REQUEST', fields: [
    ['obra', 'REF', true], ['material', 'TEXT', true], ['quantidade', 'INTEGER', true], ['unidade', 'TEXT', true], ['urgencia', 'ENUM', true, ['BAIXA', 'MEDIA', 'ALTA']],
    ['solicitante', 'TEXT', true]] },
  { sector: 'CORRESPONDENTE', formType: 'PROTOCOLO_DOCUMENTO', action: 'REGISTER_DOCUMENT', fields: [
    ['processo', 'REF', true], ['tipoDocumento', 'TEXT', true], ['entreguePor', 'TEXT', true], ['recebidoPor', 'TEXT', true], ['data', 'DATE', true], ['classificacao', 'TEXT', true]] },
  { sector: 'CORRESPONDENTE', formType: 'ANDAMENTO_PROCESSO', action: 'REGISTER_CASE_PROGRESS', fields: [
    ['processo', 'REF', true], ['etapa', 'TEXT', true], ['situacao', 'TEXT', true], ['data', 'DATE', true], ['observacao', 'TEXT', false]] },
  { sector: 'JURIDICO', formType: 'PRAZO_INTIMACAO', action: 'REGISTER_DEADLINE', fields: [
    ['processo', 'REF', true], ['tipo', 'ENUM', true, ['PRAZO', 'INTIMACAO']], ['dataCiencia', 'DATE', true], ['dataFinalPrazo', 'DATE', true], ['descricao', 'TEXT', true],
    ['conferidoPor', 'TEXT', true]] },
]);

const findForm = (formType) => FORMS.find((form) => form.formType === formType) || null;
const ACTIONS = Object.freeze([...new Set(FORMS.map((form) => form.action))]);

module.exports = { FORMS, ACTIONS, findForm };
