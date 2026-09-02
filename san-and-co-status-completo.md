# SAN & CO. — Relatório de Status Completo

> Atualizado em 26/08/2026. Três níveis: **✅ FEITO** (funciona de verdade, testado),
> **🟡 MEIO CAMINHO** (construído mas incompleto, ou construído e não conectado),
> **⚪ PLANEJADO** (decidido/discutido, zero código ainda).

---

## 1. App principal — `san-and-co/`

### 1.1 Financeiro — ✅ FEITO no front (dado como fechado)

5 sub-telas: Overview, Fluxo, Ativos, Conexões, Projetos.

**✅ Feito e testado:**
- Overview (contas, cartões, investimentos, gráfico de evolução SVG puro)
- Fluxo (extrato agrupado por dia, período navegável, upload de `.OFX`)
- Ativos (alocação por classe, tabela de ativos)
- Conexões (cards estilo Data Passport, consentimento, "Ver detalhes" e "+Nova conexão" agora navegam de verdade — a gaveta de novo banco já lista as instituições suportadas)
- Projetos (auto-provisionamento via checkout, escopo Pessoal/Comercial, filtros de status, drilldown de projeto individual em tela cheia)
- Categorização de gastos (fonte real: Pluggy, traduzida para português — sem kit próprio inventado; dois blocos, Despesas e Despesas futuras, com filtro por categoria no extrato)
- 7 telas de detalhe dedicadas: Contas, Evolução, Faturas, Projeção, Patrimônio, Ativo individual, Categoria, Projeto, Conexão

**🟡 Meio caminho:**
- Botão de topo **"+ Lançar"** — presente em toda tela do Financeiro, ainda sem formulário/destino nenhum (único botão visível que sobrou solto)
- Limite de crédito por cartão — UI pronta, só a Pluggy entrega esse dado (`.OFX` não carrega)
- Webhook do Asaas — `handleCheckoutEvent()` pronto esperando, nada dispara ele de verdade ainda
- Peso visual do dropzone `.OFX` quando a Pluggy estiver ativa — decisão de reduzir (não remover) já fechada; falta o sinal técnico real de "Pluggy conectada" em `dados.js` para ligar essa lógica condicional

### 1.2 Panteão — 🟡 MEIO CAMINHO (front rico, backend quase todo simulado)

**✅ Feito e testado:**
- Interface completa: símbolos flutuantes SVG, sidebar de conversas (Gemini-like), gaveta de anexos, popover de modelo/esforço por agente, transcrição de voz ao vivo
- **Miriel fala de verdade com a Gemini** — única conexão real de IA do projeto inteiro, testada com resposta real
- Simulação do Conselho (colaboração multiagente) — vitrine funcional, claramente marcada como placeholder

**🟡 Meio caminho:**
- Persistência de conversa — Supabase tem a tabela pronta (`panteao_conversas`/`panteao_mensagens`), front ainda salva só em memória (some ao recarregar)
- Seleção de modelo/esforço por agente — funciona na UI, nenhuma chamada real ainda lê esse valor
- Lux e Nova — sem conexão real (falta configurar billing nos provedores GPT/Claude)

**⚪ Planejado:**
- Tool Calling real (Drive/Gmail/Agenda ligados à conversa da Miriel)
- Excluir conversa → salvar no Drive + histórico permanente consultável pelos agentes
- aiOrchestrator.js (roteamento/consenso real entre os 3, hoje é ~30% de chance aleatória)
- System prompt de atendimento da Miriel — regras de tom/limites para conversar com cliente (distinto do prompt interno que já existe)

### 1.3 Rotina — 🟡 MEIO CAMINHO (v1 construída, refinamento combinado para depois)

**✅ Feito e testado:** calendário Dia/Mês/Ano navegável, protocolo biológico diário (reseta sozinho por data), Segundo Cérebro com notas.

**⚪ Planejado, com referências já discutidas:**
- Timeline do dia puxando a Agenda do Google de verdade (a peça que falta — Google já está conectado)
- Anéis de progresso circular (referência: app Fitness da Apple) em vez de barra reta
- Mapa de calor tipo GitHub na visão Mês/Ano
- "Forjar no Conselho" ligado de verdade ao Panteão (hoje só loga no console)
- Exemplos/referência para a tela ainda não trazidos pelo usuário (combinado para a próxima sessão)

### 1.4 Configuração — ⚪ PLANEJADO (quase nada construído)

Só preferências soltas hoje (lente padrão, provisão de impostos, sincronização automática) + indicador de segurança no header. Faltam: Drive como cofre de dados, motor de licenças/feature flags multiusuário (Master vs. Comercial), medidor de tokens por cliente, status de webhooks/WhatsApp/IoT. Usuário disse que vai trazer exemplos/referência na próxima sessão.

**Decisão de produto em aberto, ainda sem tela:** SaaS futuro com personalização por cliente — cada cliente escolhe o nome do próprio agente, licença comercial restrita a Finanças + Agenda + 1 agente. Arquitetura pensada, nada implementado.

---

## 2. Backend — `san-and-co/backend/`

| Peça | Status |
|---|---|
| Gemini (Miriel) | ✅ Conectada e testada com resposta real |
| Google — Drive/Gmail/Agenda | ✅ Autorizado, testado com dado real |
| Google Drive Vault (estrutura de pastas) | ✅ Criada de verdade no Drive, idempotência testada |
| Supabase (schema completo) | ✅ Criado e testado (`/api/saude` confirma) — **próximo passo combinado: front começa a enviar dado de verdade** |
| Supabase ↔ front-end (persistência de verdade) | 🟡 Banco existe, front ainda não migrou — nada persiste ainda |
| GPT (Lux) / Claude (Nova) | 🟡 Mapeamento decidido (permanente), sem billing configurado |
| Tool Calling (agentes usando Drive/Gmail/Agenda) | ⚪ Rotas prontas, nenhum agente chama nenhuma |
| Evolution API / WhatsApp | 🟡 Em andamento — Docker instalando, retomar próxima sessão |
| Pluggy (Open Finance real) | ⚪ Decidido conectar pra uso pessoal, não pra clientes ainda — zero código |
| Asaas (webhook de checkout) | ⚪ Só a assinatura da função existe, nada dispara |
| Lembretes (WhatsApp + Samsung Reminder) | ⚪ Decisão nova: lembretes centralizados pelo WhatsApp (não mais integração com Microsoft To Do); manter também os Lembretes Samsung do celular como destino secundário — zero código ainda |
| `/api/mcp` (financasRepo.js) | 🟡 Desligada — schema que ela espera (`conexoes`, colunas Pluggy) não bate com o schema real criado; precisa reconciliar (ver ⚠️ na árvore, seção 6) |
| driveVault.js | ✅ Feito (ver acima) |
| aiOrchestrator.js | ⚪ Não iniciado |
| node-cron (tarefas agendadas) | ⚪ Decidido em consenso de resiliência, não construído |

---

## 3. San Checkout — `san-checkout/` (projeto separado)

Motor de pagamento multi-tenant — cada cliente do San & Co. comercial (academia, salão etc.) tem seu próprio checkout com tema visual próprio.

**✅ Feito e testado:** front-end inteiro — HTML/CSS no tema San & Co., 7 módulos JS (máscaras, validadores com CPF real, motor de tema, fluxo Pix, fluxo Cartão), todos com testes unitários passando.

**⚪ Planejado, nada construído:** backend inteiro (`src/`) — a pasta nunca chegou a nascer no disco, não é um monte de arquivo incompleto; é o vazio mais visível do projeto inteiro agora. Sem isso, o checkout não processa pagamento nenhum de verdade, só existe visualmente.

**Decisões já fechadas, esperando implementação:**
- Formato do JSON de tema por cliente (tokens de marca variáveis, tokens de status sempre fixos)
- Identificação por `contratante_id` opaco na URL (não slug legível, não Referer)
- Tokenização de cartão pelo Asaas (dado nunca fica retido no próprio servidor)
- Nomenclatura de arquivo: evitar nomes genéricos tipo "default-logo" nas próximas criações (não retroativo)

---

## 4. Arquitetura de agentes — mapa de chamadas

Mapeamento **permanente**, decisão fechada: **Miriel = Gemini, Lux = GPT, Nova = Claude** — motivo real: o Conselho precisa de discordância genuína entre modelos diferentes, não simulada.

| Ligação planejada | Status |
|---|---|
| WhatsApp bidirecional (Miriel) | ⚪ Desenho fechado (entrada aberta a qualquer pessoa, saída por gatilho); provedor decidido (Evolution API); também vira o canal central de lembretes (ver seção 2); nada construído |
| Cadeia de auditoria noturna (Nova escaneia → Lux organiza → relatório) | ⚪ Desenho fechado, zero código |
| E-mail (leitura/resposta pela Miriel) | ⚪ Mencionado, não detalhado |
| Drive (salvar histórico de tudo) | ⚪ Mencionado, não detalhado (a estrutura de pastas já existe, a lógica de quando salvar, não) |
| Agenda ↔ Rotina ↔ Miriel | ⚪ Mencionado, não detalhado |
| Análise de documentos do Financeiro | ⚪ Mencionado, não detalhado |
| "Dezenas de outras ligações" | ⚪ Usuário confirmou que ainda vêm mais, nem entraram na lista ainda |

---

## 5. Combinado explicitamente para a próxima sessão

1. Terminar configuração da Evolution API
2. System prompt da Miriel — regras de comunicação com cliente (tom, limites)
3. Exemplos/referência para Configurações e Agenda
4. ~~Finalizar páginas que restam no Financeiro~~ — feito (categorização, drilldown de projeto, conexões)
5. Conectar Pluggy de verdade (uso pessoal só, não para clientes ainda)
6. **Migração do front para o Supabase** — banco já existe e está testado, "só falta enviar os dados" (decidido nesta sessão como próxima frente a atacar)

---

## 6. Árvore de pastas real (puxada do disco, não de memória)

```
san-and-co/
├── index.html
├── assets/
│   ├── icons/
│   │   ├── finance.svg
│   │   ├── panteao.svg
│   │   ├── agenda.svg
│   │   └── config.svg
│   └── logo/
│       ├── logo-sanco.svg
│       └── logo-sanco.png
├── css/
│   ├── main.css
│   ├── financeiro.css
│   ├── investimentos.css
│   ├── config.css
│   ├── panteao.css
│   └── agenda.css
├── js/
│   ├── app.js
│   ├── state.js
│   ├── dados.js
│   ├── bancos.js
│   ├── graficos.js
│   ├── supabase.js                    ⚠️ AINDA NÃO EXISTE — cliente do banco relacional no
│   │                                      front, previsto desde o esqueleto original, nunca
│   │                                      chegou a ser criado. É o primeiro arquivo da migração.
│   └── modules/
│       ├── auth.js
│       ├── financeiro.js
│       ├── detalhe.js
│       ├── investimentos.js
│       ├── conexoes.js
│       ├── projetos.js
│       ├── panteao.js
│       ├── agenda.js
│       └── config.js
└── backend/
    ├── server.js
    ├── package.json
    ├── .env.example
    ├── .gitignore
    ├── schema-supabase.sql
    ├── limpar-supabase.sql
    ├── routes/
    │   ├── panteao.js
    │   ├── google.js
    │   └── mcp.js                     ⚠️ DESLIGADA — ver nota abaixo
    ├── services/
    │   ├── geminiService.js
    │   ├── googleAuth.js
    │   ├── driveService.js
    │   ├── driveVault.js
    │   ├── gmailService.js
    │   ├── calendarService.js
    │   ├── supabaseClient.js
    │   ├── financasRepo.js            ⚠️ ver nota abaixo
    │   └── mcpTools.js                ⚠️ ver nota abaixo
    └── scripts/
        └── autorizar-google.js


san-checkout/
└── public/
    ├── index.html
    ├── assets/
    │   └── brands/
    │       ├── default-logo.svg
    │       └── default-logo.png
    ├── css/
    │   ├── base.css
    │   ├── theme-engine.css
    │   └── components/
    │       ├── card.css
    │       ├── forms.css
    │       └── tabs.css
    └── js/
        ├── app.js
        ├── config/
        │   └── themes.js
        ├── modules/
        │   ├── themeEngine.js
        │   ├── pixHandler.js
        │   └── cardHandler.js
        └── utils/
            ├── api.js
            ├── masks.js
            └── validators.js

        ⚠️ src/ (o backend inteiro) NÃO EXISTE ainda — pasta vazia,
           zero arquivo. É o maior buraco do projeto San Checkout.
```

### Avisos ⚠️ — o que é lixo e o que é problema real

- **`san-and-co/style.css`** — sobra morta de antes do fatiamento em 5 arquivos. Confirmado: já não existe na máquina do usuário. Nada a fazer, item encerrado.
- **`backend/routes/mcp.js`, `financasRepo.js`, `mcpTools.js`** — os três existem e são código real, não sobra. `mcp.js` está desligada em `server.js` porque `financasRepo.js` espera um schema (tabela `conexoes`, colunas de Pluggy) que não bate com o schema real criado em `schema-supabase.sql`. Três arquivos, um problema só: **reconciliar o schema**, não excluir nada. Isso é, na prática, o primeiro passo técnico da migração combinada para esta sessão.
- **`san-checkout/src/`** — não é arquivo incompleto, é pasta que nunca nasceu. Backend do Checkout inteiro por fazer, fora do escopo desta sessão (que é `san-and-co/`).

**Nenhum arquivo precisa ser excluído agora** — o único candidato (`style.css`) já não existe aí.
