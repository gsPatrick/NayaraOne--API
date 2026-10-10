'use strict';

// OcrAdapter — item 2 do ciclo de auditoria externa Marco 3. Contrato bruto:
//   "Dados extraídos ficam com source_file_id e confidence."
//   "IA nunca sobrescreve cadastro existente silenciosamente."
//   "Documento ilegível gera pendência, não dado inventado."
//
// Mesmo padrão duck-typed dos demais adapters (Bank/Insurance/Signature): interface comum,
// resolvida por resolveOcrAdapter.js, com Sandbox como fallback seguro — nenhum provedor real
// de OCR/IA foi contratado ainda, então a arquitetura fica pronta e testável (mockável) sem
// depender de rede/custo externo, como pedido explicitamente pela auditoria.
//
//   async extract(buffer, documentType) -> { fields: object, confidence: number (0..1), illegible: boolean, raw: object }
//
// SandboxOcrAdapter é DETERMINÍSTICO para permitir teste automatizado real (não aleatório):
//   - buffer contém um marcador JSON `{"__mockOcr": {...}}` em texto puro -> devolve esse
//     objeto como "fields" com confidence alta (simula extração correta de um documento
//     legível, sem precisar de um PDF/imagem real nem de rede).
//   - buffer vazio ou sem o marcador -> trata como ilegível (confidence baixa, fields vazio)
//     — "documento ilegível gera pendência, não dado inventado": o Sandbox nunca inventa CPF,
//     nome, renda etc. quando não consegue "ler" nada.
const MOCK_MARKER = '__mockOcr';

class SandboxOcrAdapter {
  // eslint-disable-next-line class-methods-use-this
  async extract(buffer, documentType) {
    const asText = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
    const markerIndex = asText.indexOf(`"${MOCK_MARKER}"`);

    if (markerIndex === -1) {
      return { fields: {}, confidence: 0, illegible: true, raw: { sandbox: true, documentType } };
    }

    try {
      const parsed = JSON.parse(asText);
      const mock = parsed[MOCK_MARKER];
      return {
        fields: mock.fields || {},
        confidence: typeof mock.confidence === 'number' ? mock.confidence : 0.95,
        illegible: false,
        raw: { sandbox: true, documentType },
      };
    } catch (err) {
      // Marcador presente mas malformado — tratamos como ilegível em vez de tentar adivinhar.
      return { fields: {}, confidence: 0, illegible: true, raw: { sandbox: true, documentType, parseError: err.message } };
    }
  }
}

module.exports = { SandboxOcrAdapter, MOCK_MARKER };
