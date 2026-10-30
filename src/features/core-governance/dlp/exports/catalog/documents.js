'use strict';

/**
 * Geradores de arquivo que NÃO são exportação pedida pelo usuário, mas que a varredura do inventário (M9-D822 teste 9) encontra em `src` e por isso precisam constar
 * do catálogo, cada um com o motivo. `mode`:
 *  - WORKFLOW_DOCUMENT: documento do fluxo de negócio (contrato, laudo, nota fiscal), gerado quando o fluxo anda e guardado no registro; a entrega a pessoas é o download
 *    do arquivo (M9-D825), não um POST /exports. Não aceita POST /exports (400 GOV_EXPORT_RESOURCE_INVALID).
 *  - DELEGATED: exportação com pipeline próprio já governado por MFA, permissão, validade e auditoria (BI, M9-D701); aparece aqui para o inventário.
 *  - NON_GENERATING: o arquivo só cita o formato (lista de tipos aceitos, comentário) e não gera nada.
 * `sourceFiles` são caminhos a partir de `src`; terminar em `/` cobre a pasta inteira.
 */
module.exports = [
  {
    code: 'legal.contract_pdf', label: 'PDF do contrato', mode: 'WORKFLOW_DOCUMENT', onDemand: false,
    reason: 'PDF da versão do contrato gerado pelo fluxo jurídico e guardado na versão; a entrega é o download do arquivo da versão.',
    sourceFiles: ['features/legal/contractPdf.service.js', 'models/ContractVersion.js'],
  },
  {
    code: 'legal.inspection_report', label: 'Laudo de vistoria em PDF', mode: 'WORKFLOW_DOCUMENT', onDemand: false,
    reason: 'Laudo gerado ao fechar a vistoria e guardado no registro da vistoria.',
    sourceFiles: ['features/legal/inspections.service.js'],
  },
  {
    code: 'correspondent.nfse_pdf', label: 'PDF da NFS-e', mode: 'WORKFLOW_DOCUMENT', onDemand: false,
    reason: 'PDF da nota emitida pelo emissor sandbox, preservado com hash no pedido de emissão; em produção o oficial do município o substitui.',
    sourceFiles: ['features/correspondent/adapters/NfseAdapter.js'],
  },
  {
    code: 'governance.bcp_form_pdf', label: 'Formulário contingencial em PDF (BCP)', mode: 'WORKFLOW_DOCUMENT', onDemand: false,
    reason: 'Folha em branco ou numerada para preenchimento no papel durante a contingência (M9-D811); não traz dado do cliente e é entregue pelo fluxo do BCP, não por POST /exports.',
    sourceFiles: ['features/core-governance/bcp/formPrint.render.js'],
  },
  {
    code: 'analytics.bi_csv', label: 'Exportação do BI (CSV)', mode: 'DELEGATED', onDemand: false,
    reason: 'POST /analytics/exports (M9-D701): permissão do BI e do domínio, MFA no alto risco, validade do arquivo, endereço assinado e auditoria.',
    sourceFiles: ['features/analytics/exports/export.generate.js', 'features/analytics/exports/export.download.js'],
  },
  {
    code: 'files.mime_allowlist', label: 'Tipos de arquivo aceitos no armazenamento', mode: 'NON_GENERATING', onDemand: false,
    reason: 'Lista de tipos aceitos no upload; não gera arquivo.', sourceFiles: ['features/files/files.service.js'],
  },
  {
    code: 'governance.share_file_mark', label: 'Marca d\'água do arquivo avulso em link externo', mode: 'NON_GENERATING', onDemand: false,
    reason: 'O link externo de arquivo avulso (M9-D823) só acrescenta a linha final da marca a texto/CSV já existente; não gera arquivo novo.', sourceFiles: ['features/core-governance/dlp/share/resources/file.js'],
  },
  {
    code: 'governance.exports_engine', label: 'Motor do POST /exports', mode: 'NON_GENERATING', onDemand: false,
    reason: 'Os formatos CSV, XLSX e PDF do próprio POST /exports: é o endpoint, não uma exportação fora dele.', sourceFiles: ['features/core-governance/dlp/exports/'],
  },
];
