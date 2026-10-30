'use strict';

/**
 * M9-D439 — Definition of Done e estrutura de pastas do Marketing, lidas do livro e da demanda (somente leitura).
 *  - DoD do livro: Caderno §17 (bloco "Definition of Done" do Marketing) e Guia §15; DoD da demanda: seção 3 da M9-D439 ("todos verdadeiros: ...").
 *  - Equivalência: o livro escreve os itens em inglês e a demanda os traz em português; a tabela abaixo diz qual item da demanda cobre cada item do livro.
 *  - Estrutura: Guia §2 ("src/modules/marketing/{...}/"); a decisão do Patrick (regra de estrutura do Marco 9) troca src/modules por src/features.
 */
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

/** Item do livro -> item da demanda que o cobre (texto exato, em minúsculas, como aparece na lista da M9-D439). */
const EQUIVALENCIA = Object.freeze({
  'content pipeline': 'content pipeline',
  'templates/versioning': 'templates e versionamento',
  'campaign/automation engine': 'campaign/automation engine',
  'consent/suppression/frequency caps': 'consent/suppression/frequency caps',
  'kill switch': 'kill switch',
  adapters: 'adapters',
  'tracking/attribution': 'tracking/attribution',
  'nay factual': 'nay factual',
  'social/site/whatsapp/e-mail': 'social/site/whatsapp/e-mail',
  '15 testes adversariais': '15 testes adversariais',
  'rls/redaction': 'rls/redaction',
  'provider failure drills': 'failure drills de provedor',
  'versioned content/templates': 'versioned content/templates',
  'automation engine': 'campaign/automation engine',
  idempotency: 'idempotência',
  'consent/suppression': 'consent/suppression/frequency caps',
  'frequency caps': 'consent/suppression/frequency caps',
  tracking: 'tracking/attribution',
  'factual validator': 'factual validator',
  'tests/failure drills verdes': 'testes e failure drills verdes',
});

/** Itens do bloco "N. Definition of Done" até o próximo item numerado. */
function itensDoBloco(linhas, inicio) {
  const fim = linhas.findIndex((l, i) => i > inicio && /^\d+\.\s+\S/.test(l)); // o bloco termina no próximo item numerado (Status ou Autochecagem)
  return linhas.slice(inicio + 1, fim < 0 ? inicio + 6 : fim).join(' ').split(/\s{2,}/).join(' ').replace(/\.\s*$/, '').split(';').map((s) => s.replace(/\.$/, '').trim()).filter(Boolean);
}

/** { caderno: [...], guia: [...] } do livro do Marketing. */
function lerDodLivro(textoCaderno) {
  const linhas = String(textoCaderno).split('\n').map((l) => l.replace(/[\uF000-\uF8FF]/g, '').replace(/^[\f\s]+/, '')); // o PDF extraído traz quebra de página (\f) e marcador de lista (área privada) no início da linha
  const guia = linhas.findIndex((l) => l.includes('GUIA DO MARCELO') && l.includes('MARKETING'));
  if (guia < 0) throw new Error('Guia do Marketing não encontrado no caderno');
  const primeiro = linhas.findIndex((l, i) => i < guia && /^\d+\.\s+Definition of Done/.test(l) && linhas.slice(i, i + 8).join(' ').includes('Content pipeline'));
  const segundo = linhas.findIndex((l, i) => i > guia && /^\d+\.\s+Definition of Done/.test(l));
  if (primeiro < 0 || segundo < 0) throw new Error('DoD do Marketing não encontrado no caderno');
  return { caderno: itensDoBloco(linhas, primeiro), guia: itensDoBloco(linhas, segundo) };
}

/** Lista do DoD da seção 3 da M9-D439 ("todos verdadeiros: a; b; c."). */
function lerDodDemanda(textoDemanda) {
  const linha = String(textoDemanda).split('\n').find((l) => l.includes('**Definition of Done do bloco**'));
  if (!linha) throw new Error('M9-D439: DoD do bloco não encontrado');
  const lista = linha.slice(linha.indexOf('todos verdadeiros:') + 'todos verdadeiros:'.length);
  return lista.split(';').map((s) => s.replace(/[.\s]+$/, '').trim()).filter(Boolean);
}

/** Estrutura do Guia §2: { raizLivro, raiz, pastas }. `raiz` já com a decisão do Patrick (src/features). */
function lerEstruturaLivro(textoCaderno) {
  const m = String(textoCaderno).match(/src\/modules\/marketing\/\{([^}]+)\}\//);
  if (!m) throw new Error('Guia §2 do Marketing: estrutura não encontrada');
  return { raizLivro: 'src/modules/marketing', raiz: 'src/features/marketing', pastas: m[1].split(',').map((s) => s.trim()).filter(Boolean) };
}

module.exports = { EQUIVALENCIA, norm, lerDodLivro, lerDodDemanda, lerEstruturaLivro };
