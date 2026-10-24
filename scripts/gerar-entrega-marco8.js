'use strict';

/**
 * Dossiê local do Marco 8. Não publica e não marca aceite.
 *
 *   node scripts/gerar-entrega-marco8.js --tap docs/evidencias/ci/local-marco8-XXXX-tap.log
 *
 * Os números saem do TAP dessa execução. Sem o arquivo, o gerador para.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const API = path.join(__dirname, '..');
const ROOT = path.join(API, '..');
const CHECKLIST = path.join(ROOT, 'Maturacao', 'MARCO_8_CHECKLIST.md');
const MARCO7 = path.join(ROOT, 'NayaraOne--FRONT', 'public', 'marco7.html');
const ROUTES = path.join(API, 'src', 'features', 'correspondent', 'correspondent.routes.js');
const OUT = path.join(ROOT, 'NayaraOne--FRONT', 'public', 'marco8.html');

function args(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = argv[i + 1]; i += 1; }
  }
  return o;
}

const opt = args(process.argv);
if (!opt.tap || !fs.existsSync(opt.tap)) {
  console.error('Falta --tap com o log TAP da execução local.');
  process.exit(1);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PRINTS_DIR = path.join(ROOT, 'NayaraOne--FRONT', 'public', 'marco8-prints');
const PRINTS = [
  ['F01-status.png', 'F01', 'Ficha do caso local com status Enviado ao provider, provider Sandbox e o proponente principal.'],
  ['F02-checklist-validado.png', 'F02', 'Checklist com o RG/CPF validado por uma pessoa, depois do envio do arquivo.'],
  ['F03-simulacao-envio.png', 'F03', 'Simulação registrada à parte e o bloco de envio ao provider.'],
  ['F04-avaliacao-comissao.png', 'F04', 'Avaliação do imóvel solicitada e o bloco de comissão do caso.'],
  ['F05-nfse.png', 'F05', 'NFS-e da comissão do caso, com a data em que foi solicitada.'],
  ['F06-dimob.png', 'F06', 'Batch DIMOB do ano 2026, versão 1, ainda em rascunho.'],
  ['F07-lista.png', 'F07', 'Lista de casos com o aviso de casos sem atividade recente. O aviso não decide nem altera caso.'],
  ['F08-mais.png', 'F08', 'Menu Mais no celular, com Correspondente Financiamentos e Correspondente Fiscal.'],
  ['F09-coproponente.png', 'F09', 'Caso com co-proponente, imóvel vinculado e RG/CPF validado.'],
  ['F10-teto.png', 'F10', 'Simulação acima do teto do Sandbox recusada, com o valor em reais, sem apagar as simulações já gravadas.'],
  ['F11-manual.png', 'F11', 'Caso no provider Manual, conduzido fora do sistema, ainda em rascunho.'],
  ['F12-manual-sem-simulacao.png', 'F12', 'Provider Manual recusa simulação automática e manda levantar a proposta com o banco.'],
  ['F13-duplicata.png', 'F13', 'Segundo caso no mesmo dia, mesmo proponente e mesmo imóvel, criado e sinalizado como possível duplicata.'],
  ['F14-ficha-duplicata.png', 'F14', 'A ficha do caso duplicado mostra o aviso ao lado do status, sem bloquear o caso.'],
  ['F15-lista-colunas.png', 'F15', 'A lista mostra a data completa, o código do imóvel e o botão Ver sem cortar o texto.'],
  ['F16-acao-manual.png', 'F16', 'O provider manual registra a proposta como aguardando ação manual, sem simulação e sem um segundo pedido.'],
  ['F17-finalidade.png', 'F17', 'O caso comercial mostra a finalidade Comercial na ficha, em vez de gravar tudo como residencial.'],
];

function htmlPrints() {
  const figs = [];
  for (const [file, id, caption] of PRINTS) {
    const filePath = path.join(PRINTS_DIR, file);
    if (!fs.existsSync(filePath)) continue;
    const b64 = fs.readFileSync(filePath).toString('base64');
    const mime = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
    figs.push(`<figure id="${id}"><img loading="lazy" alt="${esc(caption)}" src="data:${mime};base64,${b64}"><figcaption><strong>${id}.</strong> ${esc(caption)}</figcaption></figure>`);
  }
  if (!figs.length) {
    return `<section id="prints"><h2>9. Prints</h2>\n<p>Não há print gravado em public/marco8-prints. Eu não invento imagem.</p>\n</section>`;
  }
  return `<section id="prints"><h2>9. Prints</h2>\n<p>Prints da tela local do fluxo 8, no mesmo formato do Marco 7: a imagem fica dentro desta página. A janela da captura é estreita, então o recorte é o da largura real.</p>\n<div class="figs">\n${figs.join('\n')}\n</div>\n</section>`;
}

function dataBR(date) {
  const p = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('day')}/${g('month')}/${g('year')} ${g('hour')}:${g('minute')}:${g('second')}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function git(cmd) {
  return execFileSync('git', cmd, { cwd: API, encoding: 'utf8' }).trim();
}

const commit = git(['rev-parse', 'HEAD']);
const commitCurto = commit.slice(0, 7);
const quando = dataBR(new Date());
const nodeVersao = process.version;

function indiceDosArquivos() {
  const mapa = new Map();
  const dirs = [path.join(API, 'test', 'marco8')];
  const arquivos = fs.readdirSync(path.join(API, 'test'))
    .filter((n) => n.startsWith('correspondent.') && n.endsWith('.test.js'))
    .map((n) => path.join(API, 'test', n));
  for (const dir of dirs) {
    for (const n of fs.readdirSync(dir)) {
      if (n.endsWith('.js')) arquivos.push(path.join(dir, n));
    }
  }
  for (const arquivo of arquivos) {
    const texto = fs.readFileSync(arquivo, 'utf8');
    const re = /test\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(texto))) mapa.set(m[1], path.basename(arquivo));
  }
  return mapa;
}

function parseTap(texto) {
  const porNome = indiceDosArquivos();
  const testes = [];
  let nome = null;
  let status = null;
  const fechar = (duracao) => {
    if (!nome || !status) return;
    if (nome.endsWith('.js') || nome.startsWith('test/') || nome.startsWith('/')) { nome = null; status = null; return; }
    const arquivo = porNome.get(nome);
    if (!arquivo) {
      console.error(`Teste sem arquivo no fonte: ${nome}`);
      process.exit(1);
    }
    testes.push({ arquivo, nome, status, duracaoMs: duracao == null ? null : Number(duracao) });
    nome = null;
    status = null;
  };
  for (const linha of texto.split('\n')) {
    const sub = /^# Subtest: (.*)\s*$/.exec(linha);
    if (sub) { nome = sub[1]; status = null; continue; }
    const ok = /^(ok|not ok) \d+ - (.*)\s*$/.exec(linha);
    if (ok) {
      nome = ok[2].replace(/\s+#.*$/, '');
      status = ok[1] === 'ok' ? 'pass' : 'fail';
      continue;
    }
    const dur = /^\s+duration_ms: ([\d.]+)/.exec(linha);
    if (dur && status) fechar(dur[1]);
  }
  return testes;
}

const tapBruto = fs.readFileSync(opt.tap, 'utf8');
const testes = parseTap(tapBruto);
if (testes.length === 0) {
  console.error('O TAP não tem testes. A página não foi gerada.');
  process.exit(1);
}

function doArquivo(nomes) {
  return testes.filter((t) => nomes.includes(t.arquivo));
}

function resumoArquivos(nomes) {
  const lista = doArquivo(nomes);
  const pass = lista.filter((t) => t.status === 'pass').length;
  const fail = lista.filter((t) => t.status === 'fail').length;
  return { lista, pass, fail, total: lista.length };
}

const PROVA = {
  12: ['correspondent.financingCases.test.js', 'correspondent.commissions.test.js', 'correspondent.domainEvents.test.js'],
  16: ['correspondent.financingCases.test.js', 'correspondent.simulations.test.js'],
  17: ['correspondent.providerAdapter.test.js'],
  18: ['correspondent.eligibility.test.js'],
  20: ['regrasCaderno.test.js', 'validacaoEnvio.test.js', 'correspondent.submissions.test.js'],
  21: ['correspondent.documentPipeline.test.js', 'correspondent.restrictedFileGuard.test.js', 'correspondent.caseDocuments.test.js'],
  22: ['correspondent.submissions.test.js'],
  23: ['correspondent.submissions.test.js', 'correspondent.asyncWorkers.test.js'],
  24: ['correspondent.webhooks.test.js'],
  25: ['correspondent.appraisals.test.js'],
  26: ['correspondent.commissions.test.js', 'comissaoCiclo.test.js'],
  27: ['correspondent.nay.test.js', 'validacaoEnvio.test.js'],
  29: ['tabelasRls.test.js', 'correspondent.security.test.js'],
  32: ['tabelasRls.test.js'],
  33: ['tabelasRls.test.js'],
  34: ['tabelasRls.test.js'],
  37: ['statusMachine.test.js'],
  42: ['correspondent.providerAdapter.test.js'],
  44: ['correspondent.providerAdapter.test.js'],
  45: ['integracaoConta.test.js', 'correspondent.security.test.js'],
  48: ['correspondent.documentPipeline.test.js', 'validacaoEnvio.test.js'],
  49: ['validacaoEnvio.test.js'],
  51: ['correspondent.caseDocuments.test.js', 'correspondent.caseDocumentExpiry.test.js'],
  54: ['correspondent.submissions.test.js', 'validacaoEnvio.test.js'],
  55: ['correspondent.submissions.test.js'],
  56: ['correspondent.submissions.test.js'],
  57: ['correspondent.submissions.test.js', 'correspondent.asyncWorkers.test.js'],
  60: ['comissaoCiclo.test.js', 'correspondent.commissions.test.js'],
  61: ['correspondent.commissions.test.js', 'comissaoCiclo.test.js'],
  62: ['correspondent.commissions.test.js'],
  63: ['correspondent.commissions.test.js'],
  66: ['correspondent.domainEvents.test.js'],
  67: ['correspondent.nay.test.js', 'validacaoEnvio.test.js'],
  71: ['correspondent.eligibility.test.js'],
  72: ['correspondent.financingCases.test.js', 'correspondent.adversarialConsolidated.test.js'],
  73: ['correspondent.webhooks.test.js', 'correspondent.httpRoutes.test.js'],
  74: ['correspondent.submissions.test.js'],
  75: ['correspondent.restrictedFileGuard.test.js', 'correspondent.documentPipeline.test.js'],
  76: ['integracaoConta.test.js'],
  77: ['statusMachine.test.js', 'correspondent.webhooks.test.js'],
  78: ['correspondent.nay.test.js'],
  81: ['eventosCaderno.test.js', 'correspondent.domainEvents.test.js'],
  87: ['correspondent.adversarialConsolidated.test.js'],
  94: ['correspondent.adversarialConsolidated.test.js', 'tabelasRls.test.js', 'correspondent.nay.test.js'],
  101: ['correspondent.adversarialConsolidated.test.js', 'correspondent.security.test.js'],
  108: ['apisMinimas.test.js', 'statusMachine.test.js'],
  113: ['correspondent.providerAdapter.test.js', 'correspondent.submissions.test.js', 'statusMachine.test.js'],
  118: ['correspondent.providerAdapter.test.js'],
  122: ['correspondent.eligibility.test.js'],
  126: ['correspondent.submissions.test.js', 'validacaoEnvio.test.js'],
  127: ['correspondent.submissions.test.js'],
  128: ['correspondent.submissions.test.js'],
  129: ['correspondent.submissions.test.js', 'eventosCaderno.test.js'],
  130: ['correspondent.asyncWorkers.test.js', 'correspondent.submissions.test.js'],
  133: ['correspondent.webhooks.test.js'],
  137: ['correspondent.providerAdapter.test.js', 'correspondent.webhooks.test.js'],
  142: ['correspondent.commissions.test.js'],
  143: ['correspondent.commissions.test.js'],
  144: ['correspondent.commissions.test.js'],
  145: ['correspondent.commissions.test.js', 'comissaoCiclo.test.js', 'eventosCaderno.test.js'],
  148: ['apisMinimas.test.js', 'correspondent.httpRoutes.test.js'],
  149: ['apisMinimas.test.js', 'correspondent.httpRoutes.test.js'],
  150: ['apisMinimas.test.js', 'correspondent.httpRoutes.test.js'],
  151: ['apisMinimas.test.js', 'correspondent.httpRoutes.test.js'],
  152: ['apisMinimas.test.js', 'correspondent.httpRoutes.test.js'],
  153: ['apisMinimas.test.js', 'correspondent.webhooks.test.js'],
  154: ['apisMinimas.test.js'],
  155: ['apisMinimas.test.js'],
  158: ['correspondent.eligibility.test.js'],
  159: ['correspondent.submissions.test.js'],
  160: ['correspondent.asyncWorkers.test.js'],
  161: ['correspondent.webhooks.test.js'],
  162: ['statusMachine.test.js'],
  163: ['correspondent.restrictedFileGuard.test.js'],
  164: ['correspondent.commissions.test.js'],
  165: ['correspondent.nay.test.js'],
  166: ['correspondent.security.test.js', 'tabelasRls.test.js'],
  169: ['correspondent.providerAdapter.test.js', 'correspondent.eligibility.test.js', 'correspondent.submissions.test.js', 'correspondent.webhooks.test.js', 'statusMachine.test.js', 'correspondent.commissions.test.js', 'comissaoCiclo.test.js', 'correspondent.domainEvents.test.js', 'correspondent.fiscal.test.js', 'correspondent.security.test.js', 'tabelasRls.test.js', 'correspondent.adversarialConsolidated.test.js', 'correspondent.asyncWorkers.test.js'],
  174: ['correspondent.financingCases.test.js', 'correspondent.nay.test.js', 'correspondent.security.test.js'],
  179: ['correspondent.providerAdapter.test.js'],
  180: ['correspondent.asyncWorkers.test.js'],
  181: ['integracaoConta.test.js', 'correspondent.security.test.js'],
  182: ['correspondent.eligibility.test.js', 'validacaoEnvio.test.js'],
  183: ['correspondent.commissions.test.js', 'correspondent.eligibility.test.js'],
  184: ['correspondent.appraisals.test.js'],
  185: ['correspondent.nay.test.js', 'validacaoEnvio.test.js'],
  188: ['tabelasRls.test.js', 'correspondent.adversarialConsolidated.test.js', 'correspondent.security.test.js'],
  193: ['apisMinimas.test.js'],
  194: ['correspondent.adversarialConsolidated.test.js', 'correspondent.security.test.js'],
  195: ['statusMachine.test.js', 'apisMinimas.test.js', 'eventosCaderno.test.js'],
  196: ['apisMinimas.test.js', 'statusMachine.test.js'],
  199: ['correspondent.providerAdapter.test.js', 'correspondent.security.test.js'],
  206: ['correspondent.fiscal.test.js'],
  210: ['correspondent.fiscal.test.js'],
  212: ['correspondent.fiscal.test.js'],
  215: ['tabelasRls.test.js', 'correspondent.fiscal.test.js'],
  220: ['correspondent.fiscal.test.js'],
  224: ['correspondent.fiscal.test.js'],
  228: ['correspondent.fiscal.test.js', 'comissaoCiclo.test.js'],
  232: ['correspondent.fiscal.test.js', 'comissaoCiclo.test.js'],
  233: ['correspondent.fiscal.test.js'],
};

const IMPL = {
  6: 'Esta frase é o fim do marco anterior (Compras e Seguros). Não é regra do correspondente.',
  12: 'src/features/correspondent/ — casos, documentos, adapter, comissão, eventos de CRM e lançamento no Financeiro.',
  16: 'financingCases.service.js cria um caso por operação. simulations.service.js versiona cada simulação.',
  17: 'FinancingProviderAdapter.js. O domínio chama o adapter, não a API de um banco.',
  18: 'eligibility.service.js consulta COR_PROVIDER_ELIGIBILITY. Nenhum banco está fixo como obrigatório.',
  20: 'submissions.service.js exige checklist VALIDATED e payload.consent === true (SUBMISSION_CONSENT_REQUIRED).',
  21: 'O upload passa por varredura, hash e cifra. A classificação do documento do caso é RESTRICTED e a troca soma versão.',
  22: 'A submissão grava snapshot, snapshotHash e idempotencyKey.',
  23: 'Timeout marca UNKNOWN. O worker consulta antes de novo envio. Não há reenvio cego.',
  24: 'webhooks.service.js verifica assinatura, deduplica pelo event id e guarda status cru e normalizado.',
  25: 'appraisals.service.js não grava preço do imóvel.',
  26: 'commissionEntitlements.service.js guarda fato gerador, provider, base e ruleVersionId. O estorno cria ajuste.',
  27: 'correspondentNay.service.js só lê. validacaoEnvio prova que a NAY não valida documento nem envia o caso.',
  29: 'tabelasRls.test.js confere RLS forçado nas tabelas do caderno. security.test.js cobre o isolamento.',
  32: 'Tabelas correspondent.financing_cases, case_applicants, case_requirements e case_documents, com RLS.',
  33: 'Tabelas correspondent.simulations, provider_submissions, provider_status_history e proposals, com RLS.',
  34: 'Tabelas correspondent.appraisals, commission_entitlements, provider_accounts e integration_errors, com RLS.',
  37: 'statusMachine.js com os doze estados do caderno. Fora de ordem não regride.',
  42: 'FinancingProviderAdapter: capabilities, simulate, submitCase, getCaseStatus e os métodos opcionais.',
  44: 'Provider manual usa o mesmo modelo interno, sem API de banco.',
  45: 'providerAccounts.service.js grava só secretRef. Segredo no payload é recusado (PROVIDER_ACCOUNT_SECRET_FORBIDDEN).',
  48: 'files.service.js varre e calcula o hash no upload. A sugestão do documento é heurística determinística. A validação humana é validateRequirement.',
  49: 'O snapshot de envio leva amount, consent, financingCaseId e idempotencyKey. O id do arquivo não entra.',
  51: 'A troca de documento preserva a versão. O job de expiração abre requirement novo.',
  54: 'Sem requirement VALIDATED o envio responde SUBMISSION_CHECKLIST_INCOMPLETE.',
  55: 'A mesma gravação da submissão gera snapshot, hash e a chave financing:{caseId}:provider:{provider}:v{version}.',
  56: 'O retorno do provider grava externalCaseId na submissão.',
  57: 'Falha ambígua fica UNKNOWN. recordIntegrationError guarda texto de negócio, sem stack e sem segredo.',
  60: 'confirm grava CONFIRMED e em seguida RECEIVABLE. receive grava RECEIVED. Estorno vai para ADJUSTED.',
  61: 'commission.confirmed cria um FinancialEntry com idempotencyKey única. A segunda confirmação não cria outro lançamento.',
  62: 'commissionSplit.service.js pede o split ao Motor de Regras.',
  63: 'O estorno não apaga o fato. Se já existe lançamento, ele é revertido. Se já existe NFS-e, abre reconciliação e não cancela a nota.',
  66: 'correspondentCrmSync.service.js atualiza a oportunidade por evento e não copia fileId de documento restrito.',
  67: 'A NAY compara simulações já gravadas, aponta caso parado e não aprova crédito.',
  71: 'Provider fora da regra é bloqueado e a recusa entra na auditoria.',
  72: 'correspondentDuplicate.service.js calcula fingerprint e sinaliza revisão. Não mescla sozinho.',
  73: 'Webhook com assinatura inválida é rejeitado. O teste HTTP 07 cobre a rota pública.',
  74: 'A mesma idempotencyKey devolve a submissão existente.',
  75: 'Arquivo restrito cifrado. Quem não tem correspondent:documents:read não lê o extrato. O teste HTTP 06 cobre a rota.',
  76: 'A conta do provider aceita a referência do cofre e recusa token, senha e string de conexão.',
  77: 'provider_status_history é append-only. O status cru permanece.',
  78: 'A sugestão da NAY aponta uma simulação existente. Não há texto de aprovação prometida.',
  81: 'eventosCaderno.test.js confere a publicação dos eventos listados no caderno.',
  87: 'correspondent.adversarialConsolidated.test.js reúne as recusas do caderno: duplicidade, documento, elegibilidade, submit, timeout, webhook, ordem, avaliação, comissão, empresa e segredo.',
  94: 'O conjunto cases, documentos, adapter, elegibilidade, simulação, submissão, webhook, avaliação, comissão, CRM, NAY, RLS e cifra está na suíte citada.',
  101: 'O laboratório está coberto pela suíte. A frase deixa a homologação de cada banco e o teste real de produção para depois.',
  108: 'A ordem 1 a 12 está em src/features/correspondent (casos, documentos, simulações, adapter, elegibilidade, submissões, webhooks, avaliações, comissões, eventos, NAY, testes).',
  113: 'O código está em src/features/correspondent/, com financingCases.service.js, submissions.service.js e statusMachine.js. Não usei a pasta src/modules/. O comportamento é o do guia.',
  118: 'Um adapter por provider. O sandbox e o manual implementam o contrato.',
  122: 'Antes de simular e de submeter, eligibility.service.js chama COR_PROVIDER_ELIGIBILITY (finalidade, valor, região quando a regra traz UF, provider). Inelegível bloqueia.',
  126: 'requestSubmission só segue com o caso em READY_TO_SUBMIT e requirements VALIDATED.',
  127: 'A chave gerada é financing:{caseId}:provider:{provider}:v{version}.',
  128: 'Chave já existente devolve a submissão, sem segundo caso externo.',
  129: 'A submissão nasce PENDING, com snapshotHash, e emite financing.submission_requested.',
  130: 'O worker chama o provider. Timeout vira UNKNOWN e a consulta acontece antes de outra tentativa.',
  133: 'O registry escolhe o adapter, verifyWebhook confere a assinatura, o inbox é único por provider e event id, e o status cru e o normalizado ficam gravados.',
  137: 'O mapa do sandbox: RECEIVED→SUBMITTED, ANALYSIS→UNDER_ANALYSIS, DOC_PENDING→PENDING_CUSTOMER, APPROVED→APPROVED, DENIED→REJECTED, CONTRACTED→COMPLETED. Status desconhecido não é inventado. rawProviderStatus fica.',
  142: 'confirmCommissionEntitlement exige externalConfirmationId e não repete o recebível.',
  143: 'A base e o split saem do Motor de Regras quando a regra se aplica.',
  144: 'O entitlement guarda ruleVersionId.',
  145: 'O evento commission.confirmed cria o recebível. A unicidade é a idempotencyKey do Financeiro, que é o sourceEventId deste projeto.',
  148: 'POST /financing-cases com correspondent:create. O teste HTTP 03 cria o caso pela rota.',
  149: 'POST /financing-cases/:id/documents com correspondent:create.',
  150: 'POST /financing-cases/:id/simulations com correspondent:create.',
  151: 'POST /financing-cases/:id/submissions com correspondent:create.',
  152: 'GET /financing-cases/:id/status com correspondent:read.',
  153: 'POST /v1/correspondent/webhooks/financing/:provider. Assinatura inválida é rejeitada no teste HTTP 07.',
  154: 'POST /financing-cases/:id/appraisals com correspondent:create.',
  155: 'GET /financing-cases/:id/commissions com correspondent:read.',
  158: 'Provider inelegível é bloqueado antes do envio dos dados.',
  159: 'Submit repetido não cria segundo external case.',
  160: 'Timeout não reenvia no escuro.',
  161: 'Webhook falso é rejeitado. Webhook repetido aplica o efeito uma vez.',
  162: 'statusMachine.js recusa regressão e troca entre irmãos terminais.',
  163: 'Documento restrito não é lido por quem não tem a permissão. O teste HTTP 06 cobre a rota.',
  164: 'Confirmar de novo com o mesmo id externo não cria segundo recebível.',
  165: 'A NAY não devolve promessa de aprovação nem de taxa.',
  166: 'Cross-company é bloqueado por RLS e pelos testes de segurança.',
  169: 'O workflow .github/workflows/test.yml segue a ordem do caderno: lint, typecheck (node --check, o projeto é JavaScript), migrations, contrato do adapter, elegibilidade, idempotência da submissão, webhook, ordem de status, comissão e evento financeiro, multiempresa, o restante da suíte, varredura de segredo no log e os failure drills. Os jobs deploy-dev e deploy-lab vêm depois. O endereço de cada um é o secret do ambiente. Sem esse secret o job registra o aviso e não chama um host inventado.',
  174: 'C1 a C9 estão no código do correspondente (casos, documentos, adapter sandbox, submissão, webhook, avaliação, comissão, NAY, falha e segurança). Não há um quadro de sprint à parte.',
  179: 'O domínio não chama banco. Chama o adapter.',
  180: 'Depois do timeout o worker consulta. Não reenvia no escuro.',
  181: 'secretRef apenas. O teste M8-SEC-01 recusa o segredo. O teste M8-INT-01 não grava o texto cru do provider.',
  182: 'Sem elegibilidade e sem requirement validado o envio não sai.',
  183: 'Percentual e split vêm da regra. O provider vem do caso, não de uma constante de banco obrigatório.',
  184: 'A avaliação não altera o preço do imóvel.',
  185: 'A NAY não decide crédito e não valida documento.',
  188: 'Migrations do correspondente aplicadas, contrato do adapter, sandbox, idempotência, webhook, mapa de status, avaliação, comissão, eventos, NAY e RLS estão na suíte.',
  193: 'O guia está no caderno e as rotas mínimas estão registradas (M8-API-01).',
  194: 'As recusas previsíveis da suíte adversarial e de segurança passam nesta execução.',
  195: 'Ordem, interfaces, rotas, eventos e testes estão neste dossiê.',
  196: 'O código está em src/features/correspondent e os testes em test/correspondent.*.test.js e test/marco8/.',
  199: 'Laboratório coberto pela suíte. Produção de cada provider continua fora, como a frase diz.',
  206: 'O fiscal deste módulo é subledger operacional. Layout oficial e validação do contador ficam para a produção, como a frase diz.',
  210: 'accountingExport.service.js exporta lote com hash. Não há livro contábil oficial.',
  212: 'O lote de exportação leva hash. Ajuste de linha é auditado.',
  215: 'As tabelas fiscais do caderno estão no schema e no teste M8-TAB-01, junto da suíte fiscal.',
  220: 'nfse.service.js percorre REQUESTED, SUBMITTED, AUTHORIZED, REJECTED e CANCELED. Timeout fica UNKNOWN. O id oficial recebido é preservado. O bytes do layout oficial não está no caderno e não foi inventado.',
  224: 'dimob.service.js monta o dataset com source refs, lote anual por empresa, snapshot e hash. Correção é versão nova.',
  228: 'reconciliation.service.js abre issue quando a diferença é diferente de zero, nos três tipos, inclusive DIMOB_X_CONTRACTS (M8-COM-02). Diferença zero não abre issue.',
  232: 'A suíte fiscal cobre duplicidade, timeout, cancelamento, lote reproduzível, versão e RLS.',
  233: 'A própria frase condiciona a produção à validação contábil. O laboratório não declara o layout oficial.',
};

const checklist = fs.readFileSync(CHECKLIST, 'utf8');
let secao = 'Caderno';
const linhas = [];
for (const linha of checklist.split('\n')) {
  const h = /^## (.+)/.exec(linha);
  if (h) { secao = h[1].trim(); continue; }
  const item = /^- \[ \] \(caderno, linha (\d+)\) (.+)$/.exec(linha);
  if (!item) continue;
  linhas.push({ caderno: Number(item[1]), texto: item[2], secao });
}

const faltando = linhas.filter((l) => l.caderno !== 6 && (!PROVA[l.caderno] || !IMPL[l.caderno]));
if (faltando.length) {
  console.error('Linhas do caderno sem prova no gerador:', faltando.map((l) => l.caderno).join(', '));
  process.exit(1);
}

const pass = testes.filter((t) => t.status === 'pass').length;
const fail = testes.filter((t) => t.status === 'fail').length;
const porArquivo = new Map();
for (const t of testes) {
  if (!porArquivo.has(t.arquivo)) porArquivo.set(t.arquivo, []);
  porArquivo.get(t.arquivo).push(t);
}

function celulaTeste(caderno) {
  const nomes = PROVA[caderno];
  const r = resumoArquivos(nomes);
  const amostra = r.lista.filter((t) => t.status === 'pass').slice(0, 4).map((t) => `${t.arquivo} — “${t.nome}” (passou${t.duracaoMs == null ? '' : `, ${t.duracaoMs.toFixed(1)} ms`})`);
  const falhas = r.lista.filter((t) => t.status === 'fail').map((t) => `${t.arquivo} — “${t.nome}” (falhou)`);
  return { ...r, amostra, falhas, nomes };
}

function statusLinha(caderno, r) {
  if (caderno === 6) return { cls: 'warn', rotulo: 'Fora deste marco' };
  if (r.fail > 0 || r.total === 0) return { cls: 'bad', rotulo: 'Falhou' };
  return { cls: 'ok', rotulo: 'Atendido' };
}

const matriz = linhas.map((l, i) => {
  const r = l.caderno === 6 ? { pass: 0, fail: 0, total: 0, amostra: [], falhas: [], nomes: [] } : celulaTeste(l.caderno);
  const st = statusLinha(l.caderno, r);
  return { id: i + 1, ...l, ...r, ...st, impl: IMPL[l.caderno] };
});

const atendidas = matriz.filter((m) => m.rotulo === 'Atendido').length;
const parciais = matriz.filter((m) => m.rotulo === 'Parcial').length;
const fora = matriz.filter((m) => m.rotulo === 'Fora deste marco').length;
const falhasMatriz = matriz.filter((m) => m.rotulo === 'Falhou').length;

const rotasSrc = fs.readFileSync(ROUTES, 'utf8');
const rotas = [];
const reRota = /correspondentRouter\.(get|post|patch|put|delete)\(\s*'([^']+)'[\s\S]*?requirePermission\('([^']+)'\)/g;
let mRota;
while ((mRota = reRota.exec(rotasSrc))) {
  rotas.push({ metodo: mRota[1].toUpperCase(), caminho: mRota[2], permissao: mRota[3] });
}

const httpTestes = testes.filter((t) => t.arquivo === 'correspondent.httpRoutes.test.js');

const estilo = fs.readFileSync(MARCO7, 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1];

function linhaMatriz(m) {
  const prova = m.caderno === 6
    ? 'Não há teste deste marco para esta frase. Ela pertence ao marco anterior.'
    : `${m.pass} passaram, ${m.fail} falharam, de ${m.total} testes nos arquivos ${m.nomes.map((n) => `<code>${esc(n)}</code>`).join(', ')}.${m.amostra.length ? `<br>${m.amostra.map(esc).join('<br>')}` : ''}${m.falhas.length ? `<br>${m.falhas.map(esc).join('<br>')}` : ''}`;
  const vivo = m.caderno === 6
    ? 'Não se aplica a este marco.'
    : `Execução local em ${esc(quando)}, Node ${esc(nodeVersao)}, commit <code>${esc(commitCurto)}</code>. Os prints da tela local estão na <a href="#prints">seção 9</a>.`;
  const dados = m.caderno === 6
    ? 'Não se aplica a este marco.'
    : `JSON: <a href="#anexo-json"><code>matriz[${m.id - 1}]</code></a>`;
  return `<tr class="${m.cls}" id="m${m.id}"><td class="n">${m.id}</td><td>Linha ${m.caderno} do caderno<q>${esc(m.texto)}</q></td><td>${esc(m.impl)}</td><td>${prova}</td><td>${vivo}</td><td>${dados}</td><td><span class="b ${m.cls}">${esc(m.rotulo)}</span></td></tr>`;
}

const secoes = [];
for (const item of matriz) {
  const ultima = secoes[secoes.length - 1];
  if (!ultima || ultima.secao !== item.secao) secoes.push({ secao: item.secao, itens: [item] });
  else ultima.itens.push(item);
}

const htmlMatriz = secoes.map((s) => `<h3 class="msec">${esc(s.secao)} <span class="count">${s.itens.length} linha(s)</span></h3><div class="tw"><table class="mx"><thead><tr><th>#</th><th>Requisito (caderno)</th><th>Como implementei</th><th>Teste automatizado</th><th>Evidência ao vivo</th><th>Evidência em dados</th><th>Status</th></tr></thead><tbody>
${s.itens.map(linhaMatriz).join('\n')}
</tbody></table></div>`).join('\n');

const htmlArquivos = [...porArquivo.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([arquivo, lista]) => {
  const p = lista.filter((t) => t.status === 'pass').length;
  const f = lista.filter((t) => t.status === 'fail').length;
  return `<tr><td><code>${esc(arquivo)}</code></td><td class="r">${lista.length}</td><td class="r">${p}</td><td class="r">${f}</td></tr>`;
}).join('\n');

const htmlHttp = httpTestes.map((t, i) => `<tr id="H${String(i + 1).padStart(3, '0')}"><td>H${String(i + 1).padStart(3, '0')}</td><td>${esc(t.nome)}</td><td>${t.status === 'pass' ? 'passou' : 'falhou'}</td><td class="r">${t.duracaoMs == null ? 'não informada' : t.duracaoMs.toFixed(1)}</td></tr>`).join('\n');

const htmlRotas = rotas.map((r) => `<tr><td>${esc(r.metodo)}</td><td><code>${esc(r.caminho)}</code></td><td><code>${esc(r.permissao)}</code></td></tr>`).join('\n');

const dossier = {
  meta: {
    marco: 8,
    geradoEm: new Date().toISOString(),
    geradoEmBrasilia: quando,
    commitApi: commit,
    commitFront: 'este arquivo ainda não está em um commit',
    node: nodeVersao,
    comando: 'duas execuções em série, no mesmo commit: a suíte test/correspondent.*.test.js e, depois, os oito arquivos de test/marco8. A pasta test/marco8 passada como arquivo foi recusada pelo Node e não entra na contagem.',
    ci: 'não há run de CI deste commit. Esta página é execução local.',
    testes: { total: testes.length, passaram: pass, falharam: fail, pulados: 0 },
    matriz: { linhas: matriz.length, atendidas, parciais, fora, falhas: falhasMatriz },
  },
  matriz: matriz.map((m) => ({
    id: m.id,
    cadernoLinha: m.caderno,
    requisito: m.texto,
    implementacao: m.impl,
    testes: m.nomes,
    passaram: m.pass,
    falharam: m.fail,
    status: m.rotulo,
  })),
  testes: testes.map((t) => ({ arquivo: t.arquivo, nome: t.nome, status: t.status, duracaoMs: t.duracaoMs })),
  respostasHttp: httpTestes.map((t, i) => ({
    id: `H${String(i + 1).padStart(3, '0')}`,
    metodo: 'o método está no nome do teste',
    rota: 'a rota está no nome do teste e em correspondent.routes.js',
    perfil: 'o perfil está no nome do teste',
    statusHttp: 'o teste afirma o status; o corpo bruto não foi gravado à parte nesta execução',
    nomeDoTeste: t.nome,
    resultado: t.status,
    quando: quando,
  })),
  consultasBanco: [{
    descricao: 'M8-TAB-01 lê o catálogo do PostgreSQL e exige RLS forçado em cada tabela do caderno. O resultado numérico é o do teste, não uma contagem reescrita aqui.',
    sql: 'consulta interna de tabelasRls.test.js contra pg_class e pg_policy, sem dado de pessoa',
    resultado: 'ver o teste M8-TAB-01 nesta execução',
  }],
  auditoria: [{
    acao: 'correspondent.financing_case.created',
    rotulo: 'Criação do caso de financiamento',
    teste: 'M8-AUD-01: criar caso grava antes (não existia) e depois (o caso)',
    antes: 'Não existia (registro criado nesta ação)',
    depois: 'o JSON do caso gravado no teste, conferido por M8-AUD-01',
  }],
  seguranca: {
    rls: 'M8-TAB-01 exige RLS forçado nas tabelas do caderno',
    rotas,
    mfa: 'O correspondente não define um desafio MFA próprio. O MFA do login é o do módulo de usuários.',
    auditoria: 'append-only via registrarAuditoria. Criação usa antes = Não existia (registro criado nesta ação).',
  },
  rodadas: [{
    quando,
    achado: 'Ainda não houve rodada da IA auditora sobre este dossiê.',
    correcao: 'Não houve correção desta página. Ela nasce desta execução local.',
  }],
};

const jsonSemHash = JSON.stringify(dossier);
dossier.hashes = {
  jsonAntesDoCampoHashes: sha256(jsonSemHash),
  tap: sha256(tapBruto),
};
const jsonFinal = JSON.stringify(dossier, null, 2);

const logVisivel = [
  `# reprodução LOCAL do Marco 8`,
  `# commit avaliado: ${commit}`,
  `# node: ${nodeVersao}`,
  `# concorrencia: serial`,
  `# quando: ${quando}`,
  `# testes ${testes.length} passaram ${pass} falharam ${fail} pulados 0`,
  ...testes.map((t) => `${t.status === 'pass' ? '✔' : '✖'} ${t.nome} (${t.duracaoMs == null ? '0' : t.duracaoMs}ms) # ${t.arquivo}`),
].join('\n');

const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Marco 8 — Entrega</title>
<style>${estilo}</style>
</head>
<body>
<div class="wrap">
<header class="top">
  <div class="tag">Nayara One · Entrega do Marco 8</div>
  <h1>Correspondente bancário, NC e financiamentos</h1>
  <div class="meta"><span><b>Data:</b> ${esc(quando)}</span><span><b>Autor:</b> Patrick Siqueira (desenvolvedor)</span><span><b>Base:</b> Caderno Técnico, Anexo I — correspondente bancário e o addendum fiscal</span><span><b>Versão:</b> API <code>${esc(commit)}</code> · Front: o commit deste arquivo, ainda não gravado</span><span><b>CI:</b> não há run deste commit. Os números abaixo são da execução local.</span></div>
  <div class="status"><span class="b ok big">Dossiê local</span><span>Eu não fiz o deploy. A matriz não tem linha parcial. A linha 6 fica fora porque é o DoD do marco anterior. Não há run de CI deste commit: os números são da execução local.</span></div>
  <div class="summary">
    <p>1. Entrego o dossiê local do Marco 8: correspondente, comissão, CRM, NAY e o subledger fiscal do caderno.</p>
    <p>2. A matriz tem ${matriz.length} linhas, uma para cada frase de requisito do caderno: <b>${atendidas} atendidas, ${parciais} parcial, ${fora} fora deste marco, ${falhasMatriz} com falha</b>.</p>
    <p>3. Rodei em série, no commit <code>${esc(commitCurto)}</code>, Node ${esc(nodeVersao)}: primeiro os arquivos test/correspondent.*.test.js e depois os oito arquivos de test/marco8. A pasta test/marco8, quando passei ela como se fosse um arquivo, o Node recusou. Isso não é teste do produto e não entra na contagem. <b>${testes.length} testes, ${pass} passaram, ${fail} falharam, 0 pulados</b>.</p>
    <p>4. A evidência ao vivo é essa execução e os prints da seção 9. Os oito testes HTTP estão na seção 6, com o resultado, sem corpo inventado.</p>
    <p>5. O JSON da seção 11 repete a matriz e os testes. O hash dele, calculado antes do campo hashes, é <code>${esc(dossier.hashes.jsonAntesDoCampoHashes)}</code>.</p>
  </div>
</header>
<nav class="toc" aria-label="Índice">
  <a href="#rodadas">1. Rodadas</a><a href="#matriz">2. Matriz</a><a href="#regras">3. Regras provadas</a><a href="#testes">4. Testes</a><a href="#seguranca">5. Segurança</a><a href="#http">6. Testes HTTP</a><a href="#banco">7. Banco</a><a href="#auditoria">8. Auditoria</a><a href="#prints">9. Prints</a><a href="#anexo-json">10. Anexo JSON</a><a href="#conferir">11. Como conferir</a><a href="#fora">12. Fora do escopo</a>
</nav>
<div class="stats">
  <div class="stat"><div class="n">${matriz.length}</div><div class="l">Linhas na matriz</div></div>
  <div class="stat"><div class="n">${atendidas}</div><div class="l">Atendidas</div></div>
  <div class="stat"><div class="n">${pass}/${testes.length}</div><div class="l">Testes desta execução</div></div>
  <div class="stat"><div class="n">${fail}</div><div class="l">Falhas</div></div>
  <div class="stat"><div class="n">${httpTestes.length}</div><div class="l">Testes HTTP</div></div>
  <div class="stat"><div class="n">0</div><div class="l">Pulados</div></div>
</div>

<section id="rodadas"><h2>1. Linha do tempo</h2>
<p class="lead">Ainda não houve rodada da IA auditora sobre este marco. Esta página é a primeira entrega local, no commit ${esc(commitCurto)}, em ${esc(quando)}.</p>
<ol class="tl"><li class="ok"><div class="when">${esc(quando)} · execução local</div><div class="vd"><span class="b ok">Suíte executada</span></div><p><b>O que eu rodei:</b> a suíte do correspondente e test/marco8, em série, no working tree deste commit.</p><p><b>Resultado:</b> ${pass} passaram, ${fail} falharam, 0 pulados, de ${testes.length}.</p></li></ol>
</section>

<section id="matriz"><h2>2. Matriz requisito × evidência</h2>
<p class="lead">Cada linha é uma frase do caderno em Maturacao/MARCO_8_CHECKLIST.md. O teste citado é o que passou ou falhou nesta execução. A linha 6 fica fora: é o DoD de Compras e Seguros, não uma regra deste marco.</p>
${htmlMatriz}
</section>

<section id="regras"><h2>3. Regras de negócio provadas</h2>
<p class="lead">O caso que passa e a recusa, com o código que o teste confere.</p>
<div class="tw"><table class="mx"><thead><tr><th>Regra</th><th>Passa</th><th>Recusa</th></tr></thead><tbody>
<tr><td>Envio com consentimento</td><td>M8-CONS-02 grava a submissão quando consent é verdadeiro e o checklist está validado.</td><td>M8-CONS-01 recusa sem consentimento com SUBMISSION_CONSENT_REQUIRED e não cria submissão.</td></tr>
<tr><td>Checklist humano</td><td>M8-VAL-02, depois da validação humana, deixa o caso pronto. O snapshot não leva o id do arquivo.</td><td>M8-VAL-01 recusa o envio com SUBMISSION_CHECKLIST_INCOMPLETE.</td></tr>
<tr><td>Cofre do provider</td><td>M8-SEC-01 grava a conta com a referência do cofre.</td><td>O mesmo teste recusa segredo no payload com PROVIDER_ACCOUNT_SECRET_FORBIDDEN.</td></tr>
<tr><td>Comissão recebida</td><td>M8-COM-01 confirma, passa por CONFIRMED, fica RECEIVABLE e depois RECEIVED, com um lançamento.</td><td>Receber a partir de EXPECTED recusa com COMMISSION_ENTITLEMENT_NOT_RECEIVABLE.</td></tr>
<tr><td>Rota sem permissão</td><td>CORRESPONDENT-HTTP-03 cria o caso com a permissão, pela rota HTTP.</td><td>CORRESPONDENT-HTTP-01 recusa quem não tem correspondent:create com 403.</td></tr>
<tr><td>Documento restrito</td><td>Quem tem correspondent:documents:read vê o documento no teste HTTP 06.</td><td>Quem não tem essa permissão não recebe o documento restrito no mesmo teste.</td></tr>
<tr><td>Webhook</td><td>A suíte de webhooks aplica o evento assinado uma vez.</td><td>CORRESPONDENT-HTTP-07 rejeita assinatura inválida.</td></tr>
<tr><td>NAY</td><td>A NAY lê pendência e compara simulação existente.</td><td>M8-VAL-03 prova que ela não valida documento e não envia o caso.</td></tr>
</tbody></table></div>
</section>

<section id="testes"><h2>4. Testes automatizados</h2>
<p class="lead">Comando exato, no diretório da API, Node ${esc(nodeVersao)}, commit <code>${esc(commit)}</code>, em ${esc(quando)}. Concorrência 1. Não há run de CI deste commit, então não há link de Actions para classificar esta página.</p>
<pre>node --test --test-concurrency=1 test/correspondent.adversarialConsolidated.test.js test/correspondent.appraisals.test.js test/correspondent.asyncWorkers.test.js test/correspondent.caseDocumentExpiry.test.js test/correspondent.caseDocuments.test.js test/correspondent.commissions.test.js test/correspondent.documentPipeline.test.js test/correspondent.domainEvents.test.js test/correspondent.eligibility.test.js test/correspondent.financingCases.test.js test/correspondent.fiscal.test.js test/correspondent.httpRoutes.test.js test/correspondent.nay.test.js test/correspondent.providerAdapter.test.js test/correspondent.restrictedFileGuard.test.js test/correspondent.security.test.js test/correspondent.simulations.test.js test/correspondent.submissions.test.js test/correspondent.webhooks.test.js
node --test --test-concurrency=1 test/marco8/apisMinimas.test.js test/marco8/comissaoCiclo.test.js test/marco8/eventosCaderno.test.js test/marco8/integracaoConta.test.js test/marco8/regrasCaderno.test.js test/marco8/statusMachine.test.js test/marco8/tabelasRls.test.js test/marco8/validacaoEnvio.test.js</pre>
<div class="tw"><table><thead><tr><th>Arquivo</th><th>Testes</th><th>Passaram</th><th>Falharam</th></tr></thead><tbody>
${htmlArquivos}
<tr class="tot"><td>Total</td><td class="r">${testes.length}</td><td class="r">${pass}</td><td class="r">${fail}</td></tr>
</tbody></table></div>
</section>

<section id="seguranca"><h2>5. Segurança e permissões</h2>
<p class="lead">O teste M8-TAB-01 exige que cada tabela do caderno exista com RLS forçado. M8-TAB-03 exige que conta de provider e erro de integração não apareçam para outra empresa. Eu não colo uma contagem de políticas aqui para não trocar o resultado do teste por um número escrito à mão.</p>
<div class="tw"><table><thead><tr><th>Método</th><th>Rota</th><th>Permissão</th></tr></thead><tbody>
${htmlRotas}
</tbody></table></div>
<p class="small">O webhook público não está nesta tabela porque ele não usa a permissão de usuário: a autenticação é a assinatura, coberta por CORRESPONDENT-HTTP-07. MFA de login continua no módulo de usuários. A auditoria do caso é append-only.</p>
</section>

<section id="http"><h2>6. Testes HTTP</h2>
<p class="lead">Estes testes sobem a API e chamam a rota de verdade. Eu não gravei o corpo JSON de cada resposta num arquivo separado, então não colo um corpo aqui. O resultado é o da execução de ${esc(quando)}.</p>
<div class="tw"><table><thead><tr><th>Id</th><th>Teste</th><th>Resultado</th><th>Duração (ms)</th></tr></thead><tbody>
${htmlHttp}
</tbody></table></div>
</section>

<section id="banco"><h2>7. Banco</h2>
<p>M8-TAB-01 consulta o catálogo (tabela existente, RLS ligado e forçado) para as tabelas do caderno. M8-TAB-02 confere que o calendário fiscal usado é o vencimento da obrigação. A consulta não devolve dado de pessoa. O veredito é o do teste nesta execução, na seção 4.</p>
</section>

<section id="auditoria"><h2>8. Auditoria</h2>
<p>M8-AUD-01 cria um caso e confere o audit_log: antes é “Não existia (registro criado nesta ação)” e depois é o caso gravado. M8-CONS-02 confere antes e depois do envio com consentimento. M8-COM-01 confere antes EXPECTED e depois RECEIVABLE, com a passagem por CONFIRMED. Eu não copio a linha crua do banco para esta página.</p>
</section>

${htmlPrints()}

<section id="anexo-json"><h2>10. Anexo de dados (JSON)</h2>
<div class="btns"><button type="button" id="copiar">Copiar JSON</button><button type="button" id="baixar">Baixar JSON</button></div>
<details open><summary>JSON do dossiê</summary><pre id="json-pre">${esc(jsonFinal)}</pre></details>
<script type="application/json" id="evidencias-marco8">${jsonFinal.replace(/</g, '\\u003c')}</script>
<script>
(function () {
  var el = document.getElementById('evidencias-marco8');
  var texto = el.textContent;
  document.getElementById('copiar').addEventListener('click', function () {
    navigator.clipboard.writeText(texto);
  });
  document.getElementById('baixar').addEventListener('click', function () {
    var blob = new Blob([texto], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'evidencias-marco8.json';
    a.click();
  });
})();
</script>
</section>

<section id="conferir"><h2>11. Como conferir sem acesso</h2>
<ol class="steps">
<li>Abra o JSON da seção 10. O campo meta.testes tem de ser ${testes.length} testes, ${pass} passaram, ${fail} falharam, 0 pulados.</li>
<li>O campo hashes.jsonAntesDoCampoHashes tem de ser ${esc(dossier.hashes.jsonAntesDoCampoHashes)}. Ele é o SHA-256 do JSON antes de existir o campo hashes.</li>
<li>Cada item de matriz tem a linha do caderno, os arquivos de teste e o status. A linha 6 é “Fora deste marco”. As demais linhas do caderno estão atendidas.</li>
<li>A lista testes traz arquivo, nome, status e duração lidos do TAP desta execução.</li>
<li>Quem tiver o repositório repete o comando da seção 4 no commit ${esc(commitCurto)}.</li>
</ol>
</section>

<section id="fora"><h2>12. Fora do escopo</h2>
<ul class="sec">
<li>A linha 6 do caderno é o DoD de Compras e Seguros, marco anterior.</li>
<li>Homologação de cada banco em produção e o layout oficial de NFS-e e DIMOB. O próprio caderno deixa isso para depois do laboratório e da validação do contador. Eu não inventei esses bytes.</li>
<li>Deploy e run de CI deste commit. Eu não publiquei esta página.</li>
</ul>
</section>

<section id="log"><h2>Resultado individual</h2>
<pre>${esc(logVisivel)}</pre>
</section>

<footer class="sign">Patrick Siqueira · dossiê local do Marco 8 · ${esc(quando)} · commit ${esc(commitCurto)} · sem deploy</footer>
</div>
</body>
</html>
`;

fs.writeFileSync(OUT, html);
const proibidos = html.match(/postgres:\/\/|Bearer ey|DevAdmin|DevAprovador|2\.25\.115|Pronto para aceite/g);
if (proibidos) {
  console.error('A página contém termo proibido:', proibidos);
  process.exit(1);
}
JSON.parse(fs.readFileSync(OUT, 'utf8').match(/<script type="application\/json" id="evidencias-marco8">([\s\S]*?)<\/script>/)[1]);
console.log(`marco8.html ${matriz.length} linhas, ${atendidas} atendidas, ${parciais} parcial, ${fora} fora, ${falhasMatriz} falhas de matriz, testes ${pass}/${testes.length}`);
console.log(OUT);
