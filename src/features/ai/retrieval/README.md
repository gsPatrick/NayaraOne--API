# retrieval
RAG da NAY (M9-D022): ingestão segura de arquivo, URL e conhecimento homologado.

- `ingestion.*`: pipeline autorização -> malware -> hash -> classificação -> leitura (`parse/`) -> segredos (`secretScanner.js`) e PII -> chunks (`chunker.js`) -> vetores (`embedder.js`) -> índice. Estados em `ai.ingestions`; recusa de conteúdo grava REJECTED (não lança), o controller converte em 422 depois do commit.
- `urlFetcher.js`: URL só por pedido humano, com a lista `ia.rag.dominios_permitidos` E a do guarda SSRF (`nay_document`); a rede é toda de `ssrfGuard.fetchExternalUrl` (M9-D245).
- `chunks.write.js`: grava os chunks com os metadados do livro e marca a versão anterior da fonte como SUPERSEDED na mesma transação.
- Job `src/engines/jobs/aiRagJob.js`: leva a fila PENDING do conhecimento homologado até INDEXED.
- SQL só em `../readmodels/ragSupport.readmodel.js` (archGuard AI-004). Parâmetros `ia.rag.*` em `retrieval.settings.js`.
- Rotas: `POST /v1/ai/ingestions`, `GET /v1/ai/ingestions/:id`, `PUT /v1/ai/files/:fileId/classification`.
