'use strict';
/**
 * Apoio dos módulos 30-juridico-*.js da captura do fechamento do Marco 5 (não é módulo: fica fora
 * de modulos/ para o index não o executar). Ids de requisito do caderno (atomos-juridico.json),
 * sufixo único e o arquivo fictício enviado por HTTP.
 */
const Q = {
  A0305: 'M5-A0305-1ecad7', A0306: 'M5-A0306-a4b4b7', A0307: 'M5-A0307-653b7c', A0308: 'M5-A0308-e51f55', A0309: 'M5-A0309-69b0d3',
  A0100: 'M5-A0100-a24518', A0101: 'M5-A0101-c67620', A0102: 'M5-A0102-1a6313', A0103: 'M5-A0103-9d1f1e', A0104: 'M5-A0104-c10a98',
  A0105: 'M5-A0105-1c9cc6', A0106: 'M5-A0106-ace96c', A0107: 'M5-A0107-dce0a2', A0108: 'M5-A0108-eed49f', A0109: 'M5-A0109-d70c4e',
  A0110: 'M5-A0110-29f58b', A0111: 'M5-A0111-b4013c', A0112: 'M5-A0112-210dba', A0113: 'M5-A0113-48df89', A0114: 'M5-A0114-596454',
  A0115: 'M5-A0115-37e523', A0116: 'M5-A0116-245bce', A0117: 'M5-A0117-3055e0', A0118: 'M5-A0118-0dd094', A0119: 'M5-A0119-720fd1',
  A0120: 'M5-A0120-db30b1', A0121: 'M5-A0121-9d9c26', A0122: 'M5-A0122-0f8a78', A0123: 'M5-A0123-69456d', A0124: 'M5-A0124-645aeb',
  A0125: 'M5-A0125-3ef77f', A0138: 'M5-A0138-650e64', A0139: 'M5-A0139-b9fb17', A0140: 'M5-A0140-1d5cc9', A0141: 'M5-A0141-07d730',
  A0146: 'M5-A0146-95ccfc', A0147: 'M5-A0147-3b57ed', A0148: 'M5-A0148-c670b7', A0156: 'M5-A0156-d0fcff', A0157: 'M5-A0157-aeca75',
  A0158: 'M5-A0158-4d694b', A0159: 'M5-A0159-a8f148', A0160: 'M5-A0160-df7d81', A0172: 'M5-A0172-5ed491', A0173: 'M5-A0173-2531a4',
  A0174: 'M5-A0174-4f13e8', A0175: 'M5-A0175-e0569a', A0176: 'M5-A0176-ee3342', A0177: 'M5-A0177-7266b1', A0178: 'M5-A0178-2ca3fa',
  A0206: 'M5-A0206-d4f5e0', A0207: 'M5-A0207-e7daa6', A0217: 'M5-A0217-4b2e80', A0218: 'M5-A0218-5853eb', A0219: 'M5-A0219-23235a',
  A0229: 'M5-A0229-87c693', A0230: 'M5-A0230-6b9dbf', A0231: 'M5-A0231-5a2c1a', A0238: 'M5-A0238-193275', A0239: 'M5-A0239-f593a7',
  A0241: 'M5-A0241-f5402f', A0258: 'M5-A0258-4d0dd8', A0259: 'M5-A0259-51740a', A0260: 'M5-A0260-172e5a', A0271: 'M5-A0271-64d1b2',
  A0272: 'M5-A0272-9dda58', A0273: 'M5-A0273-a39e38', A0274: 'M5-A0274-fcaec5', A0275: 'M5-A0275-303a9e', A0276: 'M5-A0276-8957f9',
};

/** Lista de ids completos a partir das chaves curtas: q('A0102', 'A0217'). */
const q = (...keys) => keys.map((k) => { if (!Q[k]) throw new Error(`requisito desconhecido ${k}`); return Q[k]; });

const sufixo = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Corpo de POST /files com um PDF fictício (antivírus sandbox do ambiente descartável). */
const arquivo = (nome, texto, extra = {}) => ({ fileName: nome, mimeType: 'application/pdf', contentBase64: Buffer.from(`%PDF-1.4 ${texto}`).toString('base64'), category: 'generic', ...extra });

const DIA = 86400000;
const futuro = (dias) => new Date(Date.now() + dias * DIA).toISOString();
const passado = (dias) => new Date(Date.now() - dias * DIA).toISOString();

module.exports = { Q, q, sufixo, arquivo, futuro, passado, DIA };
