# Ativação do antivírus (ClamAV) e da leitura de documentos (Tesseract) no servidor

Autorizado pela Nayara em 24/10/2026 com duas condições: usar o servidor que já existe e só seguir
se houver capacidade e nenhum custo adicional. Se for preciso ampliar recurso ou contratar serviço,
o valor é apresentado antes e nada é ligado.

## 1. Conferir a capacidade do servidor atual (antes de qualquer coisa)

No Easypanel, em **Servidor → Monitor** (ou por SSH no servidor), anotar:

| O que olhar | Como | Preciso de |
|---|---|---|
| Memória total e livre em horário de uso | `free -m` (coluna `available`) ou o gráfico de memória do Easypanel | **2 GB livres** (medi 966 MB do ClamAV em regime; reservo o dobro para o pico de recarga das assinaturas) |
| Disco livre | `df -h` | **2 GB** (assinaturas ~110 MB, mais a imagem do Tesseract e do poppler) |
| CPU em uso | `top` / gráfico de CPU | folga para picos curtos (de 0,4 a 0,7 s por documento) |

Regra de decisão:
- **Cabe** (2 GB de memória livre e 2 GB de disco): ativar. Custo adicional: zero.
- **Não cabe**: parar e apresentar à Nayara o valor do aumento de memória do servidor (ou do servidor extra / serviço gerenciado, opções B e C da proposta). Nada é ligado antes da aprovação.

## 2. Subir o ClamAV (serviço novo no mesmo servidor)

1. Easypanel → projeto do Nayara One → **Create Service → App**, nome `clamav`.
2. Origem: imagem Docker `clamav/clamav:stable`.
3. **Mounts → Volume** `clamav-assinaturas` em `/var/lib/clamav` (evita baixar as assinaturas a cada reinício).
4. Sem domínio público. A porta `3310` só é acessível pela rede interna do projeto.
5. Limite de memória do serviço: 2 GB. Aguardar o primeiro download das assinaturas (alguns minutos) até o serviço ficar saudável.

## 3. Ligar na API

No serviço da API:
1. **Build args:** `INSTALL_DOCUMENT_ENGINES=true` (instala Tesseract em português e poppler na imagem).
2. **Environment:**
   - `ANTIVIRUS_PROVIDER=clamav`
   - `CLAMAV_HOST=<nome interno do serviço clamav no Easypanel>`
   - `CLAMAV_PORT=3310`
   - `OCR_PROVIDER=local`
3. Fazer o deploy da API.

Atenção operacional: com o antivírus ligado, se o ClamAV estiver fora do ar **todo envio de arquivo é recusado** (o sistema não aceita arquivo sem varredura). Por isso o serviço `clamav` precisa ter reinício automático e alerta de indisponibilidade.

## 4. Conferir depois da ativação (cenários que a IA da Nayara pediu)

1. Ficha de um contato → "Ler documento automaticamente": PDF fictício legível (campos lidos com origem e confiança), revisão humana (editar e "Confirmar dados e validar"), documento em branco (ilegível, sem campo inventado, validação desabilitada, pendência aberta) e arquivo de teste EICAR (recusado).
2. Caso de financiamento → Documentos: o mesmo PDF gera a sugestão "Leitura automática (…)".
3. Auditoria: lista de ações `people.document.ingest` e `people.document.update` com antes e depois.

## 5. Voltar atrás

Remover `ANTIVIRUS_PROVIDER` e `OCR_PROVIDER` do ambiente da API e fazer o deploy: o sistema volta aos adaptadores de laboratório. O serviço `clamav` pode ser pausado sem efeito nos dados.
