/**
 * SAN & CO. — módulo Panteão
 * HUD de avatares quadrados, timeline de raciocínio/execução (padrão
 * Cursor/Claude) e barra de comando multimodal flutuante.
 *
 * TROCA DE NOME DOS AGENTES
 *   Tudo que é exibido — nome, cor, função — vem só de AGENTES, no topo.
 *   O `id` interno (hermes/prometeu/hefesto) nunca aparece na tela; é só a
 *   chave que liga mensagem, avatar e cor. Trocar um nome é uma linha.
 *
 * API PÚBLICA PARA CONECTAR UM BACKEND DE VERDADE
 *   O objeto exportado tem três métodos pensados para o dia em que o
 *   aiOrchestrator.js do backend existir e passar a chamar isto via
 *   WebSocket/SSE em vez da simulação interna:
 *
 *     panteao.iniciarFluxo(agenteNome)
 *       Abre uma mensagem em progresso: acende o pulso do agente no HUD e
 *       cria a timeline vazia. Devolve o id da mensagem.
 *
 *     panteao.adicionarPassoTimeline(texto, tipo)
 *       Acrescenta um nó à timeline em progresso. tipo é 'pensamento'
 *       (ícone de relógio) ou 'comando' (ícone de terminal).
 *
 *     panteao.finalizarResposta(textoFinal, acoes)
 *       Fecha a timeline, apaga o pulso do HUD e imprime a resposta final
 *       com os chips de ação (se houver).
 *
 *   A simulação interna (enviarMensagem) usa exatamente essas três funções
 *   — não um caminho separado — então testar o fluxo simulado já prova que
 *   a API funciona de ponta a ponta para quando a chamada real chegar.
 *
 * O QUE É REAL E O QUE É SIMULADO
 *   A transcrição de voz é real: usa a Web Speech API nativa do navegador
 *   (Chrome/Edge) para converter fala em texto direto no campo de mensagem.
 *   O conteúdo das respostas e dos passos da timeline é simulado — isso
 *   fica dito no próprio texto da resposta, para nunca passar por dado real.
 */

import { sessaoLiberada } from '../state.js';

/**
 * Endereço do backend. Muda se a porta ou o host mudarem — não fica no
 * .env porque isto é FRONTEND: nada sensível mora aqui, só o endereço de
 * quem responde. A chave da Gemini nunca passa por este arquivo.
 *
 * Movida pra cá (era declarada mais abaixo, perto de turnoMirielReal) —
 * agora iniciarConversas() também precisa dela, logo no carregamento do
 * módulo, e uma const usada antes da própria linha de declaração quebra
 * com ReferenceError (temporal dead zone).
 */
const URL_BACKEND = 'http://localhost:3000';

/* ==================================================================
   1. AGENTES — único lugar a editar para renomear
   ================================================================== */
export const AGENTES = [
  {
    id: 'hermes', nome: 'Miriel', cor: '#F59E0B', funcao: 'Operacional & Rotina',
    palavrasChave: ['whatsapp', 'mensagem', 'lembrete', 'compromisso', 'agenda', 'hoje']
  },
  {
    id: 'prometeu', nome: 'Lux', cor: '#06B6D4', funcao: 'Finanças & Estratégia',
    palavrasChave: ['financ', 'gasto', 'saldo', 'projeç', 'investimento', 'orçamento']
  },
  {
    id: 'hefesto', nome: 'Nova', cor: '#F97316', funcao: 'Engenharia & IoT',
    palavrasChave: ['tema', 'código', 'app', 'sistema', 'bug', 'tela']
  }
];

const AGENTE_PADRAO = AGENTES[0].id;

function agentePorId(id) {
  return AGENTES.find((a) => a.id === id) ?? AGENTES[0];
}

/** Casa por id ou por nome (para iniciarFluxo aceitar 'Hermes' ou 'hermes'). */
function agentePorNome(nome) {
  const alvo = String(nome).trim().toLowerCase();
  return AGENTES.find((a) => a.id === alvo || a.nome.toLowerCase() === alvo) ?? AGENTES[0];
}

/**
 * Uma menção explícita no início ("@Hermes: ...", inserida pelo clique no
 * avatar ou digitada à mão) sempre vence a heurística — é o usuário
 * escolhendo o agente, não um palpite.
 */
function extrairMencao(texto) {
  const m = texto.match(/^@(\S+):\s*/);
  if (!m) return null;
  return AGENTES.find((a) => a.nome.toLowerCase() === m[1].toLowerCase()) ?? null;
}

/**
 * Heurística de vitrine para decidir quem responde na simulação, quando
 * não há menção explícita. O roteamento de verdade é o aiOrchestrator.js
 * do backend, via Gemini.
 */
function escolherAgente(texto) {
  const porMencao = extrairMencao(texto);
  if (porMencao) return porMencao.id;

  const minusc = texto.toLowerCase();
  const porNome = AGENTES.find((a) => minusc.startsWith(a.nome.toLowerCase()));
  if (porNome) return porNome.id;
  const porPalavra = AGENTES.find((a) => a.palavrasChave.some((p) => minusc.includes(p)));
  if (porPalavra) return porPalavra.id;
  return AGENTE_PADRAO;
}

/* ==================================================================
   2. ESTADO EM MEMÓRIA
   Sem backend ainda: nada disto sobrevive a um recarregamento — mesmo
   contrato que o resto do app assumiu para dado não persistido. Quando o
   Supabase existir, é aqui que a leitura/escrita de verdade entra.
   ================================================================== */

/**
 * Cada conversa é { id, titulo, tituloManual, mensagens, modo, agenteId }.
 *   modo: 'multi'      — o Conselho inteiro, os 3 agentes colaborando
 *         'individual' — só um agente, sem debate entre eles
 *   agenteId: só preenchido em modo 'individual'
 *   tituloManual: true depois que a pessoa renomeia à mão — a partir daí
 *     talvezTitular() nunca mais sobrescreve o título sozinho
 *
 * `mensagens` (a variável solta abaixo) é sempre uma REFERÊNCIA ao array
 * de mensagens da conversa ativa — trocar de conversa é só reapontar essa
 * referência, sem copiar nada; como arrays são objetos, `mensagens.push()`
 * continua mutando o mesmo array guardado dentro de `conversas`.
 */
let conversas = [];
let conversaAtivaId = null;
let proximoConversaId = 1;

/** Tamanho máximo do texto usado como título automático da conversa. */
const TAMANHO_TITULO = 42;

function novaConversa({ modo = 'multi', agenteId = null, participantes = null } = {}) {
  const titulo = modo === 'individual'
    ? `Conversa com ${agentePorId(agenteId).nome}`
    : 'Nova conversa';
  const c = {
    id: String(proximoConversaId++), titulo, tituloManual: false, mensagens: [], modo, agenteId,
    participantes,             // null = Conselho completo (3); array = personalizado (2 ou 3)
    dbId: null,               // preenchido na primeira mensagem real (ver garantirConversaPersistida)
    mensagensCarregadas: true // já é o mensagens[] certo — nasce vazia, não precisa buscar nada
  };
  conversas.unshift(c);   // mais recente primeiro, como em qualquer histórico de chat
  return c;
}

/** Garante que existe uma conversa ativa — chamada uma vez, no carregamento do módulo. */
function iniciarConversas() {
  const c = novaConversa();
  conversaAtivaId = c.id;
  mensagens = c.mensagens;
  hidratarConversasDoBackend();   // em paralelo — nunca bloqueia a tela inicial
}

/**
 * Busca as conversas reais do Supabase (hoje, só conversas individuais com
 * a Miriel — é a única que persiste, ver turnoMirielReal) e substitui a
 * lista local por elas. Se o backend estiver fora do ar, falha em
 * silêncio e o app segue exatamente como sempre funcionou: só em memória.
 */
async function hidratarConversasDoBackend() {
  try {
    const resposta = await fetch(`${URL_BACKEND}/api/panteao/conversas`);
    if (!resposta.ok) return;
    const { conversas: doBanco } = await resposta.json();
    if (!doBanco?.length) return;

    const vaziaLocal = conversas.find((c) => c.id === conversaAtivaId && c.mensagens.length === 0);
    conversas = [
      ...(vaziaLocal ? [vaziaLocal] : []),
      ...doBanco.map((d) => ({
        id: d.id,
        dbId: d.id,
        titulo: d.titulo,
        tituloManual: d.titulo_manual,
        mensagens: [],
        mensagensCarregadas: false,
        modo: d.modo,
        agenteId: d.agente_id
      }))
    ];

    redesenharPainelSidebar();
  } catch (erro) {
    console.warn('[panteão] não consegui carregar o histórico do Supabase — seguindo só em memória:', erro.message);
  }
}

/**
 * Busca as mensagens de uma conversa hidratada do backend, na primeira
 * vez que ela é aberta — a lista de conversas (hidratarConversasDoBackend)
 * só traz metadado, não o conteúdo inteiro, pra ficar leve.
 */
async function carregarMensagensDaConversa(c) {
  try {
    const resposta = await fetch(`${URL_BACKEND}/api/panteao/conversas/${c.dbId}`);
    if (!resposta.ok) return;
    const dados = await resposta.json();

    c.mensagens = (dados.mensagens ?? []).map((m) => ({
      id: m.id,
      autor: m.autor,
      agenteId: m.agente_id,
      texto: m.texto,
      acoes: m.acoes ?? [],
      timeline: null   // histórico carregado do banco não reconstrói a timeline decorativa
    }));
    c.mensagensCarregadas = true;

    if (conversaAtivaId === c.id) {
      mensagens = c.mensagens;
      redesenharFeed();
    }
  } catch (erro) {
    console.warn('[panteão] não consegui carregar as mensagens dessa conversa:', erro.message);
  }
}

/**
 * Cria a conversa no Supabase na primeira mensagem real dela — nunca
 * antes: uma "Nova conversa" vazia não deve virar linha no banco à toa.
 * Marca dbId na própria conversa local depois de criada, pra próxima
 * mensagem só atualizar, não criar de novo.
 */
async function garantirConversaPersistida(c) {
  if (c.dbId) return c.dbId;
  try {
    const resposta = await fetch(`${URL_BACKEND}/api/panteao/conversas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titulo: c.titulo, modo: c.modo, agenteId: c.agenteId })
    });
    if (!resposta.ok) throw new Error(`o backend respondeu ${resposta.status}`);
    const criada = await resposta.json();
    c.dbId = criada.id;
  } catch (erro) {
    console.warn('[panteão] não consegui criar a conversa no Supabase — segue só em memória:', erro.message);
  }
  return c.dbId;
}

/** Troca a conversa ativa. Sem efeito se o id já é o ativo. */
function trocarConversa(id) {
  if (id === conversaAtivaId) return;
  const alvo = conversas.find((c) => c.id === id);
  if (!alvo) return;
  conversaAtivaId = alvo.id;
  mensagens = alvo.mensagens;
  fecharSidebar();
  redesenharFeed();
  statusOcioso();
  atualizarTituloCabecalho();

  if (alvo.dbId && !alvo.mensagensCarregadas) {
    carregarMensagensDaConversa(alvo);
  }
}

/** "+ Nova conversa" — cria e já troca para ela. Se a conversa atual ainda
 *  está vazia, reaproveita ela em vez de empilhar "Nova conversa" repetida. */
function criarConversa() {
  const atual = conversas.find((c) => c.id === conversaAtivaId);
  if (atual && atual.mensagens.length === 0 && atual.modo === 'multi') {
    fecharSidebar();
    return;
  }

  const c = novaConversa();
  conversaAtivaId = c.id;
  mensagens = c.mensagens;
  fecharSidebar();
  redesenharFeed();
  statusOcioso();
  atualizarTituloCabecalho();
  const bloco = composer?.querySelector('[data-regiao="sugestoes"]');
  if (bloco) bloco.outerHTML = htmlSugestoesInline();
}

/**
 * Os 3 cards da sidebar "Falar com <agente>" — sempre cria uma conversa
 * nova (não reaproveita uma individual vazia do mesmo agente): a pessoa
 * pode querer duas conversas separadas com o mesmo agente, sobre assuntos
 * diferentes, e isso é dela decidir, não do app.
 */
function criarConversaIndividual(agenteId) {
  const c = novaConversa({ modo: 'individual', agenteId });
  conversaAtivaId = c.id;
  mensagens = c.mensagens;
  fecharSidebar();
  redesenharFeed();
  statusOcioso();
  atualizarTituloCabecalho();
  const bloco = composer?.querySelector('[data-regiao="sugestoes"]');
  if (bloco) bloco.outerHTML = htmlSugestoesInline();
}

/**
 * Conselho personalizado — só um subconjunto dos 3 agentes participa
 * (ex.: Miriel + Nova). Continua sendo modo 'multi' por baixo, só com
 * `participantes` restringindo quem simularConselho() convida a falar.
 */
function criarConversaPersonalizada(ids) {
  const c = novaConversa({ modo: 'multi', participantes: ids });
  c.titulo = ids.map((id) => agentePorId(id).nome).join(' + ');
  c.tituloManual = true;
  conversaAtivaId = c.id;
  mensagens = c.mensagens;
  fecharSidebar();
  redesenharFeed();
  statusOcioso();
  atualizarTituloCabecalho();
  const bloco = composer?.querySelector('[data-regiao="sugestoes"]');
  if (bloco) bloco.outerHTML = htmlSugestoesInline();
}

/**
 * Deriva o título da conversa a partir da primeira mensagem do usuário —
 * só se ninguém renomeou à mão ainda, e só na primeira mensagem.
 */
function talvezTitular(conversaId, texto) {
  const c = conversas.find((c) => c.id === conversaId);
  if (!c || c.tituloManual || c.mensagens.length > 1 || !texto) return;
  c.titulo = texto.length > TAMANHO_TITULO ? `${texto.slice(0, TAMANHO_TITULO)}…` : texto;
}

/** Renomear à mão, pelo lápis na sidebar. Marca tituloManual para nunca
 *  mais ser sobrescrito por talvezTitular(). */
function renomearConversa(id, novoTitulo) {
  const c = conversas.find((c) => c.id === id);
  if (!c) return;
  const limpo = novoTitulo.trim();
  if (!limpo) return;   // título vazio não é permitido — mantém o anterior
  c.titulo = limpo.length > TAMANHO_TITULO ? `${limpo.slice(0, TAMANHO_TITULO)}…` : limpo;
  c.tituloManual = true;

  if (c.dbId) {
    fetch(`${URL_BACKEND}/api/panteao/conversas/${c.dbId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titulo: c.titulo })
    }).catch((erro) => console.warn('[panteão] não consegui renomear no Supabase:', erro.message));
  }
}

let mensagens = [];
let anexoPendente = null;
let proximoId = 1;
let fluxoAtual = null;   // { msgId, agenteId, iniciadoEm }

/** Soma real de tokens da sessão — só cresce com resposta de verdade da
 *  Gemini (a única conexão real hoje). Some ao recarregar, como o resto
 *  do Panteão ainda em memória. */
let tokensUsados = { total: 0 };
const sessaoIniciadaEm = new Date();

function registrarUsoTokens(uso) {
  if (!uso?.totalTokenCount) return;
  tokensUsados.total += uso.totalTokenCount;
  const alvo = cabecalho?.querySelector('[data-regiao="token-contador"]');
  if (alvo) alvo.textContent = tokensUsados.total.toLocaleString('pt-BR');
}

iniciarConversas();

/* ==================================================================
   3. FORMATAÇÃO
   ================================================================== */
function escapar(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Markdown mínimo: **negrito**, `código inline` e blocos ```código```. */
function formatarCorpo(texto) {
  const partes = escapar(texto).split(/```([\s\S]*?)```/g);
  return partes.map((parte, i) => {
    if (i % 2 === 1) {
      return `
        <div class="msg-codigo">
          <button class="msg-codigo__copiar" type="button" data-copiar-codigo>Copiar</button>
          <pre><code>${parte}</code></pre>
        </div>`;
    }
    return parte
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }).join('');
}

function tamanhoLegivel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function tempoLegivel(segundos) {
  const m = Math.floor(segundos / 60);
  const s = Math.floor(segundos % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ==================================================================
   4. ÍCONES DESENHADOS (sem fonte de ícone, sem emoji — mesma linha do
      resto do app: dropzone__icone, SVG_LUPA em detalhe.js, etc.)
   ================================================================== */

const SVG_RELOGIO = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.4 1.4"/>
</svg>`;

const SVG_TERMINAL = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/>
  <path d="M4.2 6.2 6.6 8l-2.4 1.8"/><line x1="8" y1="10.4" x2="11.5" y2="10.4"/>
</svg>`;

const SVG_ANEXAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 5v14M5 12h14"/>
</svg>`;

const SVG_MIC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="9" y="3" width="6" height="11" rx="3"/>
  <path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="21"/>
</svg>`;

const SVG_ENVIAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <line x1="4" y1="12" x2="20" y2="12"/><polyline points="14 6 20 12 14 18"/>
</svg>`;

/** Ícone em barra usado no chip "Abrir no Financeiro" — desenhado, não emoji. */
const SVG_GRAFICO = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"
     stroke-linecap="round" aria-hidden="true">
  <line x1="3" y1="13" x2="3" y2="8"/><line x1="8" y1="13" x2="8" y2="4"/><line x1="13" y1="13" x2="13" y2="10"/>
</svg>`;

/** Menu hambúrguer — abre a barra lateral de conversas. */
const SVG_MENU = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
     stroke-linecap="round" aria-hidden="true">
  <line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/>
</svg>`;

/** Quadrado com lápis — "nova conversa", mesmo idioma do Gemini/ChatGPT. */
const SVG_NOVA_CONVERSA = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6"/>
  <path d="M18.4 3.6a1.7 1.7 0 0 1 2.4 2.4L12 15l-3.5.9.9-3.5 9-8.8Z"/>
</svg>`;

/** X desenhado — fechar a barra lateral. */
const SVG_FECHAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
     stroke-linecap="round" aria-hidden="true">
  <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
</svg>`;

/** Lupa — buscar entre as conversas. */
const SVG_LUPA_CONVERSA = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"
     stroke-linecap="round" aria-hidden="true">
  <circle cx="7" cy="7" r="5"/><line x1="14" y1="14" x2="10.5" y2="10.5"/>
</svg>`;

/** Lápis — renomear uma conversa na barra lateral. */
const SVG_LAPIS = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M11.3 2.3a1.5 1.5 0 0 1 2.1 2.1L5.5 12.3l-2.8.7.7-2.8Z"/>
</svg>`;

/** Três pontinhos — abre o menu de uma conversa (renomear/excluir). */
const SVG_TRES_PONTOS = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/>
</svg>`;

/** Lixeira — excluir conversa, dentro do menu de três pontinhos. */
const SVG_LIXEIRA = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M6.5 7.5v4M9.5 7.5v4"/>
  <path d="M3.5 4.5 4 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l.5-8.5"/>
</svg>`;

/** Duas cabeças sobrepostas — "conselho personalizado", escolher quem entra. */
const SVG_PERSONALIZADO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5"/>
  <circle cx="17" cy="7" r="2.4" opacity="0.75"/><path d="M14.8 13.7c2.6 0.2 4.7 2.2 4.7 5.3" opacity="0.75"/>
</svg>`;

/** Ícones das sugestões acopladas e da gaveta de anexos — sempre desenhados,
 *  nunca emoji, para seguir a mesma linha visual do resto do app. */
const SVG_RAIO = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M8.6 1 3 9h3.6l-1.2 6L13 7H9.2Z"/>
</svg>`;

const SVG_CHAVE = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M10.2 2.8a3 3 0 0 0-4 3.9L2 11l1 1 .9-.9.9.9 1-1-.9-.9L6 9l.5.5 1-1L7 8l.4-.4a3 3 0 0 0 2.8-4.8Z"/>
</svg>`;

/** Calendário simples — sugestão sobre agenda/rotina. */
const SVG_CALENDARIO = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="2" y="3.5" width="12" height="10.5" rx="1.5"/>
  <line x1="2" y1="6.5" x2="14" y2="6.5"/><line x1="5" y1="2" x2="5" y2="5"/><line x1="11" y1="2" x2="11" y2="5"/>
</svg>`;

/** Estrela de 4 pontas — sugestão de propósito geral/insight, sem ligação
 *  a um agente específico. */
const SVG_INSIGHT = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M8 1.5c.4 2.4 1.6 3.6 4 4C9.6 5.9 8.4 7.1 8 9.5c-.4-2.4-1.6-3.6-4-4 2.4-.4 3.6-1.6 4-4Z"/>
  <path d="M13 9.5c.2 1.2.8 1.8 2 2-1.2.2-1.8.8-2 2-.2-1.2-.8-1.8-2-2 1.2-.2 1.8-.8 2-2Z" opacity="0.7"/>
</svg>`;

const SVG_CAMERA = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1L5.4 2.6A1 1 0 0 1 6.2 2h3.6a1 1 0 0 1 .8.6L11.5 4h1A1.5 1.5 0 0 1 14 5.5v6A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5Z"/>
  <circle cx="8" cy="8.3" r="2.3"/>
</svg>`;

/** Clipe de papel — "Enviar arquivos". */
const SVG_CLIPE = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M10.8 3.2 5.4 8.6a2.1 2.1 0 0 0 3 3l5-5a3.4 3.4 0 0 0-4.8-4.8L3.4 7"/>
</svg>`;

/** Triângulo geométrico — "Adicionar do Drive" (a integração real vem depois). */
const SVG_DRIVE = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"
     stroke-linejoin="round" aria-hidden="true">
  <path d="M6.1 2.2h3.8L14 9.4h-3.8Z"/>
  <path d="M2 9.4h3.8L2 15.8Z" fill="currentColor" stroke="none"/>
  <path d="M4.5 14.2h7L14 9.4H8.2Z" fill="currentColor" opacity="0.55" stroke="none"/>
</svg>`;

/* ==================================================================
   4.1 CATEGORIAS DA GAVETA DE ANEXOS
   ================================================================== */
/**
 * Lista de anexos — textos idênticos ao padrão Gemini/ChatGPT mostrado como
 * referência. Sem submenu, sem "Mais uploads": só o que tem uso real aqui.
 *
 *   tipo 'arquivo' -> abre o seletor de arquivo do sistema, com o accept
 *                     próprio da linha.
 *   tipo 'drive'    -> sem backend ainda. A integração de verdade com o
 *                      Google Drive (e as demais ferramentas do Google)
 *                      entra quando essa peça existir; por ora, o clique
 *                      só avisa no console.
 */
const ACOES_ANEXO = [
  { id: 'arquivos', icone: SVG_CLIPE,  rotulo: 'Enviar arquivos',    tipo: 'arquivo', accept: '' },
  { id: 'drive',    icone: SVG_DRIVE,  rotulo: 'Adicionar do Drive', tipo: 'drive' },
  { id: 'imagem',   icone: SVG_CAMERA, rotulo: 'Adicionar imagem',   tipo: 'arquivo', accept: 'image/*' }
];

/* ==================================================================
   5. FRAGMENTOS DE INTERFACE
   ================================================================== */

/**
 * Símbolos flutuantes dos agentes — traço fino, mesmo idioma visual do
 * resto do app. Os três abaixo são os ícones que o usuário enviou (fada,
 * sol e estrela) — a cor de cada um continua vindo de fora, via a custom
 * property --agente escrita no wrapper, não fixa no SVG.
 */

/** Miriel — ícone próprio (fada), enviado pelo usuário. Substitui o glifo
 *  desenhado que existia antes; a cor continua vindo de fora (--agente). */
const SVG_SIMBOLO_MIRIEL = `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg"
 width="1341.000000pt" height="1341.000000pt" viewBox="0 0 1341.000000 1341.000000"
 preserveAspectRatio="xMidYMid meet">
<g transform="translate(0.000000,1341.000000) scale(0.100000,-0.100000)"
fill="currentColor" stroke="none">
<path d="M985 9971 c-194 -31 -286 -59 -423 -128 -160 -82 -269 -171 -375
-310 -72 -94 -151 -274 -173 -393 -12 -66 -10 -415 3 -485 14 -76 32 -141 49
-182 8 -17 14 -37 14 -45 0 -22 65 -189 111 -284 53 -110 204 -364 269 -453
229 -312 282 -373 570 -662 402 -403 694 -638 1240 -995 58 -38 115 -74 127
-80 12 -7 67 -38 123 -71 194 -111 216 -123 385 -209 94 -47 177 -89 185 -94
34 -18 242 -105 370 -154 52 -21 107 -44 122 -51 14 -8 34 -15 45 -15 10 0 27
-7 37 -15 11 -8 30 -15 43 -15 13 0 31 -4 41 -9 15 -9 145 -47 247 -73 22 -5
58 -16 79 -24 51 -18 56 -11 56 81 0 163 77 548 134 680 8 17 21 50 31 75 10
25 26 63 36 86 33 71 60 45 -316 294 -63 41 -138 91 -167 111 -29 20 -114 76
-188 125 -74 49 -148 99 -165 111 -16 11 -160 107 -320 213 -159 106 -295 197
-300 204 -6 6 -26 20 -45 30 -19 11 -75 47 -125 80 -49 33 -157 105 -240 159
-190 127 -231 160 -270 222 -47 75 -65 137 -65 231 0 69 5 92 29 146 97 214
335 306 541 209 35 -16 174 -105 328 -210 45 -31 114 -76 152 -101 38 -25 169
-112 291 -195 122 -82 231 -156 243 -163 68 -41 485 -319 560 -374 33 -24 65
-45 71 -48 6 -3 110 -71 232 -152 121 -82 225 -148 230 -148 5 0 33 25 63 56
183 189 441 376 671 487 43 21 79 43 82 51 5 13 -35 74 -102 156 -16 19 -51
62 -78 94 -110 136 -395 430 -551 570 -108 96 -160 141 -262 224 -24 21 -64
54 -89 75 -24 22 -61 50 -80 63 -20 13 -65 47 -101 74 -91 70 -335 239 -408
285 -34 21 -62 42 -62 46 0 5 -5 9 -11 9 -6 0 -90 47 -187 106 -219 130 -193
115 -282 162 -168 88 -309 159 -370 186 -36 16 -92 41 -125 56 -154 70 -295
124 -465 179 -102 34 -198 66 -215 72 -16 6 -46 15 -65 19 -19 4 -48 13 -65
18 -72 25 -150 40 -385 78 -228 36 -558 42 -735 15z"/>
<path d="M11851 9980 c-77 -8 -297 -41 -396 -60 -56 -10 -134 -30 -170 -42
-16 -5 -46 -14 -65 -18 -19 -4 -48 -13 -65 -19 -16 -6 -119 -41 -228 -77 -109
-35 -206 -69 -215 -73 -9 -5 -57 -26 -107 -46 -49 -21 -127 -55 -173 -76 -46
-22 -85 -39 -88 -39 -2 0 -32 -13 -67 -29 -34 -16 -69 -32 -77 -35 -8 -4 -42
-22 -75 -41 -33 -19 -96 -53 -140 -76 -97 -49 -81 -40 -301 -172 -228 -138
-278 -170 -449 -290 -193 -135 -317 -227 -378 -280 -29 -25 -86 -72 -128 -104
-126 -97 -411 -361 -533 -493 -32 -36 -91 -99 -130 -141 -39 -41 -96 -106
-126 -143 -30 -38 -62 -76 -71 -85 -8 -9 -25 -32 -37 -52 -12 -19 -30 -44 -42
-54 -40 -36 -27 -59 58 -101 242 -120 534 -334 691 -506 19 -21 38 -38 44 -38
5 0 48 26 95 57 48 32 94 62 104 68 28 17 251 166 288 192 19 14 179 121 355
238 176 117 336 224 355 238 69 48 362 243 431 287 86 55 78 49 280 185 219
147 267 169 374 167 105 -2 223 -58 295 -139 113 -128 133 -293 53 -462 -35
-76 -94 -121 -548 -420 -60 -40 -121 -81 -135 -90 -14 -10 -155 -105 -315
-211 -159 -106 -306 -204 -325 -217 -19 -13 -161 -108 -315 -210 -154 -102
-296 -196 -315 -210 -19 -14 -77 -52 -127 -85 -53 -34 -93 -67 -93 -76 0 -9 8
-34 19 -56 10 -23 26 -61 36 -86 9 -25 22 -54 28 -65 5 -11 14 -33 18 -50 5
-16 15 -55 24 -85 48 -161 95 -441 95 -561 0 -42 2 -78 5 -81 3 -3 29 1 58 9
106 28 124 34 227 64 58 17 116 34 130 37 14 3 34 11 45 18 11 8 28 14 38 14
10 0 31 6 45 14 15 8 45 21 67 29 142 55 378 153 425 177 8 4 105 54 215 109
110 56 214 110 230 120 35 22 221 130 250 146 11 6 61 37 110 69 50 33 115 75
145 95 180 115 563 402 690 516 25 22 69 60 99 85 200 166 521 498 727 750
136 166 347 493 423 655 18 39 37 78 42 88 17 32 78 202 85 235 4 18 11 35 15
38 5 3 9 20 9 37 1 18 7 43 15 57 8 14 14 44 15 67 0 50 16 97 30 88 7 -4 10
53 10 166 0 144 -2 174 -16 183 -8 7 -18 32 -21 56 -13 106 -95 295 -172 395
-101 133 -209 223 -358 301 -38 20 -75 39 -83 44 -31 18 -189 60 -300 81 -130
24 -460 34 -609 19z"/>
<path d="M6540 6893 c-132 -11 -379 -67 -475 -108 -110 -47 -313 -156 -379
-203 -241 -173 -458 -424 -571 -662 -25 -51 -91 -219 -105 -265 -6 -22 -16
-53 -22 -70 -6 -16 -14 -52 -18 -80 -4 -27 -14 -63 -20 -80 -9 -21 -13 -107
-13 -290 0 -216 3 -267 17 -304 9 -24 16 -55 16 -69 0 -15 6 -44 14 -67 7 -22
21 -65 31 -95 9 -30 21 -64 25 -75 5 -11 26 -60 46 -110 91 -218 261 -443 484
-639 71 -62 189 -139 315 -205 55 -29 105 -56 110 -61 6 -4 21 -10 35 -13 14
-3 49 -14 79 -26 59 -22 226 -63 332 -80 85 -14 427 -14 505 -1 150 27 225 45
304 72 47 16 96 32 110 35 14 3 30 9 35 13 6 4 55 31 110 60 185 96 303 185
464 349 94 97 271 335 271 366 0 5 6 16 13 24 8 9 30 57 51 106 20 50 41 97
46 106 5 9 12 33 15 53 4 20 11 39 16 42 5 3 9 17 9 32 0 15 7 40 15 56 8 15
15 43 15 61 0 18 6 48 14 66 19 46 29 334 16 474 -9 113 -24 197 -42 250 -5
17 -13 46 -18 65 -15 68 -113 313 -137 341 -7 8 -13 20 -13 26 0 20 -152 232
-225 316 -99 112 -233 229 -362 314 -55 36 -243 132 -328 168 -199 83 -529
128 -785 108z"/>
</g>
</svg>`;

/** Lux — ícone próprio (sol/luz), enviado pelo usuário. */
const SVG_SIMBOLO_LUMEN = `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg"
 width="1800.000000pt" height="1800.000000pt" viewBox="0 0 1800.000000 1800.000000"
 preserveAspectRatio="xMidYMid meet">
<g transform="translate(0.000000,1800.000000) scale(0.100000,-0.100000)"
fill="currentColor" stroke="none">
<path d="M8866 14370 c-61 -24 -101 -62 -127 -119 -18 -42 -19 -75 -19 -918 0
-866 0 -874 21 -915 39 -76 117 -127 195 -128 59 0 142 45 179 98 l30 44 3
885 c1 597 -1 897 -8 924 -14 52 -78 112 -142 133 -62 20 -71 20 -132 -4z"/>
<path d="M12541 12889 c-39 -12 -82 -53 -795 -768 -257 -257 -476 -480 -486
-496 -25 -37 -35 -120 -21 -171 14 -50 62 -109 112 -134 52 -27 137 -27 192 1
60 31 1237 1208 1267 1268 33 67 26 162 -17 220 -18 24 -47 53 -65 64 -39 23
-136 32 -187 16z"/>
<path d="M5205 12811 c-116 -52 -166 -188 -108 -296 25 -49 1218 -1242 1268
-1269 55 -29 136 -28 195 3 53 27 63 39 97 110 29 61 27 114 -6 179 -28 53
-1218 1240 -1273 1268 -52 28 -117 30 -173 5z"/>
<path d="M8690 11745 c-8 -2 -49 -8 -90 -14 -366 -54 -691 -181 -1015 -396
-130 -86 -299 -229 -409 -346 -84 -89 -226 -261 -226 -274 0 -4 -13 -24 -28
-44 -65 -83 -242 -415 -242 -453 0 -8 -4 -18 -8 -23 -13 -14 -50 -129 -96
-290 -64 -228 -96 -637 -66 -835 6 -36 15 -99 20 -140 9 -79 34 -207 49 -250
5 -14 17 -54 26 -90 43 -159 175 -451 270 -594 25 -38 45 -71 45 -73 0 -2 42
-58 93 -124 179 -232 262 -359 355 -544 106 -212 150 -337 223 -645 16 -71 49
-367 49 -453 0 -79 11 -114 52 -166 37 -48 77 -65 159 -65 66 -1 81 2 117 27
23 15 54 46 69 69 l28 42 -2 181 c-1 100 -7 210 -13 246 -6 35 -15 92 -20 126
-24 177 -103 450 -194 668 -31 74 -161 328 -192 375 -19 28 -34 53 -34 55 0 8
-98 147 -169 238 -278 360 -406 628 -475 992 -48 254 -32 632 37 875 66 231
128 368 270 595 57 91 180 237 298 352 154 150 384 302 584 386 50 21 99 42
110 47 43 18 222 70 242 70 12 0 34 5 49 11 89 33 445 51 614 30 309 -39 620
-143 829 -276 361 -232 619 -514 781 -855 68 -141 97 -223 139 -390 50 -193
55 -245 54 -500 0 -156 -5 -263 -13 -295 -6 -27 -16 -75 -21 -105 -5 -30 -16
-80 -25 -110 -9 -30 -22 -75 -29 -100 -56 -189 -175 -416 -317 -602 -93 -124
-235 -332 -277 -408 -53 -96 -161 -319 -161 -333 0 -7 -4 -17 -9 -22 -22 -23
-126 -353 -155 -490 -44 -208 -67 -418 -68 -610 0 -100 3 -128 20 -166 76
-173 335 -168 399 7 6 18 14 106 17 196 8 210 40 434 83 583 52 183 53 185
103 310 41 100 117 256 153 312 15 24 27 45 27 47 0 10 140 213 187 271 102
126 199 280 277 440 50 103 61 128 91 205 40 103 51 140 89 282 48 177 81 491
73 673 -6 133 -33 354 -48 392 -5 13 -9 36 -9 50 0 15 -7 51 -16 82 -69 238
-105 334 -184 491 -51 102 -62 122 -128 227 -185 297 -465 576 -759 759 -160
100 -363 202 -448 224 -16 5 -61 19 -100 33 -133 46 -248 74 -426 102 -69 11
-167 15 -345 14 -137 -1 -256 -3 -264 -4z"/>
<path d="M12456 9245 c-15 -8 -34 -15 -40 -15 -20 0 -83 -72 -100 -114 -46
-113 18 -250 133 -284 55 -17 1737 -17 1792 0 22 6 55 27 74 45 118 115 93
279 -55 359 -33 18 -74 19 -905 22 -760 2 -874 0 -899 -13z"/>
<path d="M3760 9141 c-97 -21 -170 -111 -170 -211 0 -78 41 -147 115 -191 l40
-24 890 0 c872 0 891 0 925 20 161 93 159 304 -3 392 -30 17 -93 18 -897 20
-476 0 -881 -2 -900 -6z"/>
<path d="M11415 6717 c-22 -12 -54 -44 -72 -70 -42 -63 -51 -121 -27 -189 17
-49 65 -100 622 -658 332 -333 620 -616 640 -629 50 -32 172 -36 218 -7 103
67 139 183 90 288 -21 43 -1219 1244 -1267 1269 -51 27 -153 25 -204 -4z"/>
<path d="M6465 6658 c-16 -6 -46 -23 -65 -39 -76 -60 -1211 -1206 -1230 -1241
-27 -50 -27 -151 -1 -193 43 -71 123 -124 186 -125 17 0 51 8 78 17 41 15 124
94 658 628 335 336 620 626 632 645 33 52 30 160 -5 216 -56 87 -160 125 -253
92z"/>
<path d="M7894 5811 c-66 -16 -122 -76 -144 -155 -25 -91 25 -203 111 -246 37
-20 65 -20 1074 -20 1136 0 1061 -4 1128 59 101 93 83 260 -35 338 l-42 28
-1030 2 c-567 0 -1045 -2 -1062 -6z"/>
<path d="M7843 5211 c-57 -41 -77 -71 -93 -135 -22 -94 15 -176 110 -239 22
-16 115 -17 1075 -17 l1050 0 37 23 c68 41 108 112 108 189 0 72 -43 147 -103
183 l-44 25 -1050 0 -1050 0 -40 -29z"/>
<path d="M7858 4648 c-51 -27 -93 -83 -108 -143 -22 -89 18 -182 105 -240 30
-20 47 -20 1081 -20 l1050 0 42 28 c120 79 137 244 35 338 -67 63 9 59 -1130
58 -1023 0 -1039 -1 -1075 -21z"/>
<path d="M8885 4030 c-302 -3 -561 -10 -575 -14 -35 -12 -88 -64 -111 -108
-24 -46 -25 -137 -3 -181 23 -45 62 -85 109 -110 40 -22 45 -22 625 -22 486 0
591 2 620 14 152 63 192 247 79 361 -30 29 -98 56 -159 62 -19 1 -282 1 -585
-2z"/>
</g>
</svg>`;

/** Nova — ícone próprio (estrela/supernova), enviado pelo usuário. */
const SVG_SIMBOLO_NOVA = `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg"
 width="1536.000000pt" height="1536.000000pt" viewBox="0 0 1536.000000 1536.000000"
 preserveAspectRatio="xMidYMid meet">
<g transform="translate(0.000000,1536.000000) scale(0.100000,-0.100000)"
fill="currentColor" stroke="none">
<path d="M7360 15279 c-290 -15 -360 -20 -490 -35 -74 -8 -178 -21 -230 -30
-52 -8 -110 -14 -128 -14 -19 0 -61 -6 -95 -14 -75 -18 -175 -37 -242 -46 -27
-4 -72 -13 -100 -20 -27 -6 -75 -18 -105 -25 -30 -7 -77 -19 -105 -25 -27 -7
-68 -16 -90 -19 -23 -4 -47 -11 -55 -16 -8 -5 -32 -12 -55 -16 -22 -4 -53 -11
-70 -17 -61 -21 -111 -36 -145 -43 -19 -4 -51 -13 -70 -19 -19 -7 -51 -18 -70
-25 -19 -7 -51 -18 -70 -24 -19 -7 -48 -16 -65 -21 -45 -12 -159 -53 -210 -75
-29 -12 -65 -26 -157 -61 -24 -9 -55 -22 -70 -30 -14 -8 -31 -14 -37 -14 -10
0 -43 -14 -211 -92 -106 -49 -503 -248 -535 -269 -16 -10 -39 -23 -50 -29 -11
-5 -27 -14 -35 -20 -26 -17 -172 -100 -175 -100 -2 0 -33 -20 -69 -45 -37 -25
-68 -45 -70 -45 -13 0 -419 -281 -496 -343 -8 -7 -53 -41 -100 -77 -123 -93
-341 -275 -465 -390 -237 -218 -609 -612 -770 -815 -21 -27 -42 -52 -45 -55
-21 -18 -248 -323 -346 -465 -79 -114 -114 -167 -114 -171 0 -2 -19 -32 -43
-67 -24 -34 -46 -69 -50 -77 -4 -8 -16 -28 -27 -45 -11 -16 -24 -39 -30 -50
-6 -11 -26 -47 -45 -80 -19 -33 -40 -69 -45 -80 -6 -11 -19 -33 -29 -50 -16
-25 -97 -179 -186 -355 -22 -44 -75 -157 -100 -215 -8 -16 -27 -59 -43 -95
-16 -36 -37 -85 -46 -110 -10 -25 -24 -58 -32 -73 -8 -16 -14 -35 -14 -42 0
-7 -7 -27 -15 -44 -8 -17 -22 -45 -30 -62 -8 -17 -15 -38 -15 -48 0 -9 -7 -26
-15 -37 -8 -10 -15 -27 -15 -36 0 -10 -6 -32 -14 -50 -17 -42 -35 -94 -46
-133 -5 -16 -14 -46 -21 -65 -6 -19 -17 -51 -24 -70 -12 -33 -24 -76 -45 -160
-5 -19 -18 -66 -30 -105 -12 -38 -25 -88 -30 -110 -20 -92 -32 -143 -46 -189
-8 -26 -14 -59 -14 -71 0 -13 -5 -36 -12 -52 -6 -15 -14 -50 -18 -78 -4 -27
-12 -79 -19 -115 -44 -232 -71 -410 -71 -465 0 -22 -5 -58 -11 -80 -21 -84
-33 -407 -33 -860 0 -446 9 -680 34 -875 34 -265 43 -321 56 -380 8 -36 14
-78 14 -93 0 -15 6 -56 14 -90 8 -34 22 -98 31 -142 9 -44 23 -103 31 -131 8
-28 14 -59 14 -69 0 -10 7 -43 16 -74 9 -31 22 -80 30 -108 36 -134 45 -167
60 -221 9 -31 22 -73 29 -92 7 -19 21 -62 30 -95 10 -33 23 -74 30 -90 7 -17
16 -45 19 -62 4 -18 12 -35 17 -38 5 -4 9 -16 9 -28 0 -12 7 -31 15 -41 8 -11
15 -28 15 -38 0 -9 6 -32 14 -50 8 -18 29 -69 46 -113 18 -44 39 -95 46 -112
8 -18 20 -48 27 -65 56 -136 227 -490 317 -653 27 -49 55 -101 62 -115 8 -14
53 -90 102 -170 48 -80 93 -154 99 -165 7 -11 24 -36 40 -56 15 -20 27 -39 27
-42 0 -28 429 -608 530 -717 8 -9 30 -35 49 -58 75 -91 54 -27 -27 80 -23 31
-42 59 -42 63 0 3 -5 11 -10 18 -22 26 -80 106 -80 110 0 4 -228 392 -250 427
-6 8 -13 22 -16 30 -4 8 -53 110 -109 225 -56 116 -110 230 -120 255 -10 25
-23 59 -30 75 -7 17 -21 50 -30 75 -9 25 -23 58 -31 73 -8 16 -14 35 -14 42 0
7 -6 26 -14 42 -24 47 -65 159 -91 248 -10 33 -23 78 -30 100 -16 52 -38 125
-60 200 -10 33 -24 77 -31 98 -8 20 -14 51 -14 67 0 16 -5 41 -11 57 -6 15
-14 51 -19 78 -4 28 -12 71 -19 98 -6 26 -16 68 -22 95 -18 74 -37 194 -64
412 -8 69 -20 157 -26 195 -15 105 -30 612 -24 845 6 208 24 439 50 630 8 58
16 123 19 145 3 22 10 67 16 100 6 33 18 96 26 140 8 44 20 100 26 125 6 25
14 63 18 85 4 22 13 63 20 90 6 28 19 77 27 110 8 33 19 74 25 90 5 17 14 46
18 65 5 19 18 67 30 105 12 39 25 84 30 100 4 17 18 55 30 85 12 30 25 69 30
85 10 36 28 89 46 130 7 17 20 50 29 75 10 25 23 57 31 72 8 14 14 31 14 37 0
6 14 41 31 78 16 38 36 82 43 98 95 213 235 486 323 630 7 11 17 29 23 40 6
11 19 34 30 50 11 17 23 37 27 45 4 8 14 26 24 40 9 14 48 72 86 130 78 118
133 200 145 215 5 6 45 60 90 120 45 61 88 116 95 123 7 7 34 41 60 75 26 34
50 64 53 67 3 3 30 34 60 70 98 116 132 152 350 370 306 306 561 521 903 763
88 63 216 147 223 147 2 0 32 19 67 43 34 24 69 46 77 50 8 4 42 23 75 42 33
19 69 40 80 45 11 6 34 19 50 29 32 21 420 216 495 249 25 11 75 34 113 51 37
17 71 31 76 31 5 0 22 6 38 14 26 13 56 25 158 63 22 8 54 20 70 27 41 18 94
36 130 46 33 9 87 27 125 43 14 5 41 13 60 17 19 5 49 13 65 18 48 17 202 59
310 85 33 8 83 21 110 27 28 7 68 16 90 20 22 5 67 13 100 20 282 55 500 86
715 100 69 5 168 13 220 19 119 13 612 14 745 1 55 -6 143 -13 195 -15 52 -3
142 -12 200 -20 335 -45 357 -48 440 -64 152 -28 219 -43 375 -81 28 -7 68
-16 90 -20 22 -4 54 -12 70 -18 17 -6 56 -17 88 -26 115 -32 173 -49 207 -61
19 -7 51 -18 70 -24 19 -7 49 -16 65 -21 48 -13 98 -31 128 -46 16 -8 35 -14
42 -14 7 0 26 -6 42 -14 15 -8 46 -21 68 -29 90 -33 129 -49 285 -119 25 -11
59 -26 75 -33 67 -29 399 -199 440 -225 17 -10 53 -31 80 -46 88 -48 99 -55
127 -72 15 -9 59 -37 98 -62 39 -25 79 -49 88 -55 19 -11 117 -78 222 -151 81
-57 253 -185 260 -194 3 -3 23 -19 45 -36 42 -31 80 -61 100 -81 6 -6 41 -35
76 -64 35 -29 82 -70 104 -90 22 -21 58 -54 80 -75 138 -127 398 -390 460
-465 12 -13 50 -58 85 -99 166 -192 351 -436 486 -640 49 -74 91 -139 94 -145
5 -10 42 -70 68 -110 6 -11 17 -29 22 -40 6 -11 19 -33 30 -50 11 -16 24 -39
30 -50 6 -11 26 -47 44 -80 42 -75 185 -359 221 -440 24 -54 41 -91 79 -180 8
-16 21 -50 31 -75 9 -25 23 -58 30 -75 33 -78 89 -233 105 -290 9 -33 27 -87
43 -125 5 -14 13 -41 17 -60 5 -19 13 -48 18 -65 6 -16 18 -57 27 -90 9 -33
22 -76 28 -95 6 -19 14 -53 17 -75 4 -22 13 -62 20 -90 38 -157 56 -241 71
-340 4 -27 12 -81 19 -120 65 -395 74 -525 73 -1046 0 -477 -4 -532 -49 -815
-8 -49 -14 -109 -14 -131 0 -49 -19 -151 -75 -408 -7 -33 -21 -96 -30 -140
-22 -105 -44 -194 -57 -225 -6 -14 -14 -41 -18 -60 -5 -19 -13 -50 -19 -68 -6
-17 -16 -47 -22 -65 -6 -17 -15 -48 -19 -67 -4 -19 -13 -48 -19 -65 -6 -16
-20 -59 -32 -95 -31 -91 -48 -137 -58 -158 -5 -9 -17 -37 -26 -62 -21 -55 -43
-106 -61 -143 -8 -16 -14 -35 -14 -42 0 -7 -6 -26 -14 -42 -111 -223 -196
-401 -196 -408 0 -4 -6 -16 -13 -24 -7 -9 -22 -36 -32 -61 -11 -25 -30 -61
-43 -80 -13 -19 -28 -44 -33 -55 -5 -11 -17 -32 -27 -47 -9 -15 -61 -100 -116
-189 -54 -89 -125 -199 -157 -243 -162 -222 -274 -372 -283 -382 -6 -6 -65
-76 -131 -155 -156 -187 -546 -577 -750 -749 -158 -134 -401 -322 -481 -372
-22 -15 -47 -32 -55 -40 -24 -23 -134 -98 -174 -118 -11 -6 -33 -19 -50 -30
-16 -11 -39 -24 -50 -30 -11 -6 -32 -18 -47 -28 -102 -65 -259 -156 -348 -201
-58 -29 -130 -66 -160 -82 -30 -16 -71 -36 -90 -44 -19 -9 -55 -27 -79 -40
-24 -14 -50 -25 -57 -25 -7 0 -25 -6 -41 -14 -36 -17 -86 -39 -143 -61 -25
-10 -60 -24 -77 -31 -18 -8 -48 -20 -65 -28 -34 -14 -89 -35 -155 -60 -21 -8
-65 -22 -98 -31 -33 -10 -73 -23 -90 -31 -16 -7 -43 -14 -59 -16 -16 -2 -31
-9 -34 -15 -5 -18 58 -17 122 1 28 8 76 21 106 29 30 8 75 20 100 26 25 7 63
16 85 21 22 4 56 13 75 20 19 7 51 18 70 25 19 7 51 18 70 24 19 7 49 16 65
20 17 4 40 13 52 19 12 7 32 12 45 12 13 0 28 4 34 9 5 6 27 14 49 20 44 10
93 27 143 47 18 8 40 14 48 14 9 0 28 6 42 13 29 15 87 41 137 61 38 16 90 38
135 58 19 9 71 30 115 48 95 39 177 75 225 99 49 25 224 118 295 158 33 18 67
35 75 39 8 3 22 10 30 15 8 5 38 20 65 34 28 15 64 35 80 45 17 11 37 23 45
27 8 4 43 26 78 50 35 24 65 43 68 43 2 0 33 20 70 45 36 25 67 45 69 45 21 0
501 351 615 449 19 17 39 31 43 31 5 0 21 11 35 24 15 13 79 70 142 127 63 57
120 108 126 113 6 6 60 56 120 111 135 124 155 144 277 277 54 58 114 124 135
145 70 74 221 248 253 293 18 25 35 47 39 50 18 13 325 423 337 450 4 8 28 47
54 85 68 102 183 278 189 290 3 6 18 30 34 54 29 45 72 124 146 266 23 44 70
134 105 200 64 121 96 185 119 240 7 17 20 46 28 65 9 19 51 118 93 220 42
102 83 199 90 215 7 17 20 47 29 68 9 21 16 46 16 57 0 11 6 34 14 52 20 49
37 98 47 143 6 21 14 44 18 50 5 5 11 24 14 40 2 17 10 46 17 65 7 19 18 51
25 70 7 19 20 62 30 95 9 33 23 80 31 105 8 25 14 55 14 68 0 13 5 32 11 43 6
11 14 41 19 67 5 26 13 65 19 87 5 22 17 74 25 115 8 41 22 109 30 150 8 41
22 120 31 175 9 55 22 136 31 180 8 44 14 101 14 126 0 26 6 84 14 130 8 46
16 143 20 215 5 133 11 168 27 158 5 -3 9 185 9 451 0 266 -4 454 -9 451 -16
-10 -22 27 -31 199 -5 93 -14 188 -19 210 -6 22 -11 58 -11 80 0 55 -27 233
-71 465 -7 36 -15 88 -19 115 -4 28 -12 63 -18 78 -7 16 -12 39 -12 52 0 12
-6 45 -14 71 -14 46 -26 97 -46 189 -5 22 -18 72 -30 110 -12 39 -25 86 -30
105 -21 84 -33 127 -45 160 -7 19 -18 51 -24 70 -7 19 -16 49 -21 65 -11 39
-29 91 -46 133 -8 18 -14 40 -14 50 0 9 -7 26 -15 36 -8 11 -15 28 -15 37 0
17 -6 31 -44 107 -9 19 -16 40 -16 47 0 7 -6 26 -14 42 -8 15 -22 48 -32 73
-9 25 -30 74 -46 110 -16 36 -35 79 -43 95 -25 58 -78 171 -100 215 -89 176
-170 330 -186 355 -10 17 -23 39 -29 50 -5 11 -26 47 -45 80 -19 33 -39 69
-45 80 -6 11 -19 34 -30 50 -11 17 -23 37 -27 45 -4 8 -26 43 -50 77 -24 35
-43 65 -43 67 0 4 -35 57 -114 171 -98 142 -325 447 -346 465 -3 3 -24 28 -45
55 -162 204 -528 592 -770 815 -122 113 -341 297 -465 390 -47 36 -92 70 -100
77 -77 62 -483 343 -496 343 -2 0 -33 20 -70 45 -36 25 -67 45 -69 45 -3 0
-149 83 -175 100 -8 6 -24 15 -35 20 -11 6 -33 19 -50 29 -16 11 -129 69 -250
129 -241 120 -331 163 -462 218 -21 9 -51 23 -66 30 -16 8 -35 14 -42 14 -7 0
-26 6 -42 14 -15 8 -48 22 -73 31 -25 9 -53 21 -63 26 -19 11 -175 65 -222 79
-16 4 -46 14 -65 21 -19 6 -51 17 -70 24 -19 7 -51 18 -70 25 -19 6 -51 15
-70 19 -34 7 -84 22 -145 43 -16 6 -48 13 -70 17 -23 4 -47 11 -55 16 -8 5
-32 12 -55 16 -22 3 -62 12 -90 19 -27 6 -75 18 -105 25 -30 7 -77 19 -105 25
-27 7 -72 16 -100 20 -27 4 -79 12 -115 19 -36 7 -96 19 -135 26 -85 16 -206
33 -338 45 -55 6 -103 12 -107 15 -8 5 -128 13 -510 35 -185 10 -399 10 -600
-1z"/>
<path d="M5385 11100 c-88 -9 -178 -22 -200 -29 -22 -6 -53 -11 -70 -11 -48 0
-211 -36 -336 -76 -26 -7 -57 -14 -70 -14 -13 -1 -35 -7 -49 -15 -14 -8 -36
-15 -50 -15 -14 0 -34 -7 -44 -15 -11 -8 -29 -15 -40 -15 -12 0 -30 -7 -40
-15 -11 -8 -29 -15 -41 -15 -12 0 -30 -7 -41 -15 -10 -8 -27 -15 -36 -15 -18
0 -40 -9 -178 -73 -196 -91 -243 -116 -407 -214 -184 -110 -322 -206 -472
-330 -141 -117 -176 -149 -285 -259 -178 -179 -225 -233 -364 -413 -57 -72
-220 -313 -242 -356 -6 -11 -25 -47 -43 -80 -18 -33 -44 -80 -57 -105 -13 -25
-29 -52 -35 -60 -6 -8 -20 -35 -30 -60 -10 -25 -29 -70 -42 -100 -91 -204
-105 -239 -123 -305 -5 -16 -14 -46 -21 -65 -6 -19 -17 -51 -24 -70 -7 -19
-18 -51 -25 -70 -7 -19 -16 -55 -20 -80 -4 -25 -13 -67 -20 -95 -30 -123 -40
-165 -54 -238 -9 -43 -16 -94 -16 -115 0 -20 -7 -73 -16 -117 -12 -63 -16
-157 -16 -435 -2 -415 6 -496 73 -810 6 -30 15 -77 20 -105 7 -46 23 -105 48
-180 5 -16 17 -57 27 -90 9 -33 23 -75 30 -93 8 -18 14 -41 14 -52 0 -10 6
-31 14 -47 20 -39 67 -146 91 -208 43 -108 76 -173 180 -360 17 -29 43 -77 59
-107 26 -48 71 -114 168 -248 18 -25 48 -67 66 -95 19 -27 49 -67 69 -88 19
-21 57 -66 86 -100 111 -136 163 -174 124 -92 -9 20 -17 44 -17 55 0 11 -6 34
-14 52 -19 45 -60 194 -75 273 -4 22 -13 58 -19 80 -16 61 -34 144 -42 200 -4
28 -12 75 -18 105 -16 82 -40 265 -57 437 -22 214 -22 829 0 1048 9 88 22 199
30 246 8 47 15 100 15 117 0 29 7 70 45 260 48 238 68 324 87 377 5 17 13 46
17 65 4 19 12 51 18 70 6 19 19 62 28 95 9 33 23 75 31 93 8 18 14 41 14 50 0
10 5 23 11 29 6 6 14 26 19 44 12 50 58 173 106 287 67 157 65 152 158 342 83
168 116 230 156 295 10 17 31 53 46 80 15 28 61 101 103 163 42 63 81 121 86
130 15 25 218 296 225 302 4 3 33 37 65 75 156 185 341 368 566 559 53 45 222
171 246 184 12 7 27 18 35 25 11 11 76 54 143 94 158 96 222 131 345 190 80
39 165 78 190 88 25 9 59 23 75 30 17 8 38 15 48 17 10 2 19 8 20 13 3 16 -74
14 -248 -5z"/>
<path d="M9800 11050 c0 -6 8 -13 18 -16 9 -3 24 -9 32 -14 8 -5 51 -27 95
-50 44 -23 94 -50 110 -61 17 -10 37 -22 45 -26 8 -3 31 -19 51 -35 20 -15 39
-28 42 -28 6 0 230 -150 237 -159 3 -4 37 -31 75 -61 39 -30 72 -57 75 -60 3
-3 37 -31 75 -62 176 -140 525 -511 667 -709 24 -33 70 -97 102 -142 33 -45
86 -127 118 -182 32 -55 63 -107 68 -115 6 -8 15 -24 20 -35 6 -11 24 -42 40
-70 27 -44 87 -166 124 -250 32 -72 79 -172 92 -197 8 -14 14 -35 14 -45 0
-10 6 -27 14 -38 7 -11 16 -31 19 -45 3 -14 15 -50 27 -80 12 -30 25 -68 30
-85 4 -16 12 -41 18 -55 5 -14 17 -54 27 -90 9 -36 22 -87 30 -115 45 -171 56
-221 91 -445 8 -52 19 -120 25 -151 30 -177 32 -820 3 -985 -8 -44 -14 -100
-14 -125 0 -47 -22 -187 -45 -279 -7 -30 -21 -91 -30 -135 -21 -102 -44 -190
-60 -235 -7 -19 -20 -62 -30 -95 -9 -33 -23 -75 -31 -93 -8 -18 -14 -41 -14
-52 0 -11 -7 -36 -16 -57 -9 -21 -23 -54 -31 -73 -8 -19 -21 -48 -27 -65 -7
-16 -21 -48 -30 -70 -10 -22 -25 -56 -33 -75 -8 -19 -22 -51 -30 -70 -8 -19
-21 -48 -28 -65 -7 -16 -16 -37 -19 -45 -3 -8 -14 -28 -24 -45 -16 -25 -56
-99 -119 -215 -68 -124 -87 -154 -215 -331 -32 -43 -58 -82 -58 -85 0 -6 -58
-83 -70 -94 -3 -3 -23 -27 -45 -55 -21 -27 -44 -54 -50 -60 -6 -5 -47 -53 -91
-105 -44 -52 -134 -147 -199 -210 -66 -63 -122 -117 -125 -120 -3 -3 -39 -35
-80 -71 -68 -59 -112 -94 -300 -239 -98 -75 -344 -231 -468 -297 -139 -73
-313 -160 -362 -181 -19 -8 -48 -21 -63 -28 -16 -8 -35 -14 -42 -14 -7 0 -26
-6 -42 -14 -53 -27 -99 -45 -213 -86 -19 -6 -51 -15 -71 -19 -19 -4 -42 -11
-49 -16 -7 -5 -30 -12 -49 -16 -20 -4 -49 -12 -66 -17 -75 -26 -138 -41 -367
-86 -40 -8 -107 -22 -148 -30 -41 -9 -102 -16 -135 -16 -33 -1 -105 -7 -160
-15 -140 -20 -617 -20 -740 0 -49 8 -118 15 -152 15 -34 0 -97 7 -140 16 -186
37 -231 46 -273 56 -25 6 -65 14 -90 18 -41 6 -74 15 -155 42 -16 5 -43 13
-60 18 -16 5 -45 13 -62 19 -18 6 -48 16 -65 22 -18 6 -46 14 -63 19 -45 12
-89 28 -210 77 -146 59 -144 58 -338 155 -178 88 -181 90 -242 129 -22 14 -47
29 -55 33 -25 11 -52 28 -129 81 -40 28 -80 55 -89 60 -50 31 -233 172 -356
275 -132 110 -323 302 -457 457 -153 178 -213 258 -345 458 -37 55 -75 112
-85 127 -11 15 -19 29 -19 32 0 2 -19 37 -43 78 -24 40 -60 107 -81 148 -21
41 -49 98 -63 125 -14 28 -31 64 -39 80 -7 17 -24 55 -37 85 -14 30 -35 80
-47 110 -12 30 -28 69 -35 85 -15 37 -34 90 -45 130 -5 17 -20 64 -33 105 -14
41 -32 102 -42 135 -9 33 -22 80 -30 105 -7 25 -20 81 -29 125 -10 44 -24 108
-32 142 -8 34 -14 73 -14 88 0 15 -7 57 -15 94 -8 36 -17 84 -21 106 -6 37 -8
38 -14 15 -20 -64 2 -568 32 -755 6 -38 14 -101 18 -140 12 -108 31 -216 46
-260 8 -23 14 -52 14 -67 0 -14 7 -45 15 -68 8 -23 15 -54 15 -69 0 -23 11
-66 42 -156 5 -16 13 -46 18 -65 4 -19 12 -46 18 -60 5 -14 18 -52 27 -85 22
-75 42 -132 61 -168 8 -16 14 -36 14 -45 0 -9 7 -26 15 -36 8 -11 15 -28 15
-37 0 -10 6 -30 14 -46 8 -15 22 -48 31 -73 9 -25 21 -52 26 -60 5 -8 12 -22
15 -30 16 -38 167 -338 184 -365 10 -16 25 -41 33 -55 43 -80 166 -277 218
-350 33 -47 75 -107 93 -135 29 -45 74 -101 140 -175 12 -14 44 -54 71 -89 80
-105 319 -353 444 -461 35 -30 71 -62 80 -71 93 -89 381 -311 500 -385 35 -21
75 -47 90 -56 14 -10 33 -21 41 -25 8 -5 42 -26 75 -48 33 -21 83 -51 110 -66
84 -44 378 -191 410 -204 88 -36 147 -61 205 -87 55 -24 110 -45 170 -64 30
-9 71 -22 90 -29 19 -7 62 -20 95 -30 33 -9 71 -22 85 -27 14 -6 41 -14 60
-18 19 -5 49 -13 65 -18 17 -6 62 -17 100 -25 39 -8 106 -22 150 -32 44 -9
107 -23 140 -30 33 -8 119 -21 190 -29 72 -9 173 -21 225 -28 157 -20 731 -22
856 -4 58 9 133 16 167 17 34 0 82 4 107 9 25 4 63 11 85 14 22 4 72 13 110
21 39 8 108 21 155 30 47 9 103 20 125 26 22 6 56 14 75 19 33 8 107 30 225
66 28 8 66 19 85 24 49 11 186 62 285 105 17 7 50 20 75 30 25 9 58 23 73 31
16 8 33 14 39 14 10 0 132 60 368 181 69 36 172 96 230 134 58 39 109 72 114
74 4 2 37 23 72 47 35 24 67 44 70 44 6 0 83 58 94 70 3 3 50 41 105 83 174
134 210 166 440 387 153 146 433 473 531 620 17 25 52 77 79 115 86 125 125
184 135 207 6 13 20 39 31 58 12 19 32 55 46 80 14 25 40 72 59 105 34 61 95
183 121 242 7 18 20 48 29 68 8 19 21 50 30 70 8 19 21 50 30 70 38 90 48 112
61 137 7 14 13 33 13 42 0 8 6 30 14 48 7 18 21 60 31 93 9 33 23 75 31 93 8
18 14 41 14 52 0 11 6 34 14 52 26 62 38 103 46 148 4 25 12 65 18 90 6 25 18
81 27 125 9 44 21 100 27 125 13 52 20 104 37 250 6 58 18 161 27 230 17 145
20 636 4 740 -6 36 -14 124 -20 195 -5 72 -13 153 -19 180 -5 28 -17 88 -26
135 -9 47 -22 117 -30 155 -8 39 -17 86 -19 105 -3 19 -15 67 -26 105 -12 39
-25 86 -30 105 -4 19 -13 49 -18 65 -6 17 -18 55 -27 85 -29 102 -78 247 -94
278 -5 9 -17 37 -26 62 -9 25 -23 59 -30 75 -7 17 -20 50 -30 75 -20 51 -44
108 -56 130 -4 8 -40 78 -79 155 -104 203 -150 288 -166 306 -8 8 -14 18 -14
21 0 3 -34 56 -75 118 -41 62 -75 114 -75 116 0 6 -83 119 -162 220 -43 54
-100 128 -128 163 -91 117 -383 411 -552 556 -156 135 -319 265 -333 265 -3 0
-42 27 -85 60 -43 33 -82 60 -85 60 -3 0 -29 17 -58 39 -51 37 -110 73 -212
126 -27 14 -72 39 -100 56 -27 16 -63 37 -80 45 -16 8 -44 23 -62 34 -17 10
-123 58 -234 106 -112 47 -210 90 -218 94 -16 8 -59 24 -131 49 -19 7 -53 17
-75 22 -22 6 -44 14 -49 20 -13 12 -76 12 -76 -1z"/>
<path d="M7460 10850 c-91 -3 -171 -9 -178 -13 -6 -5 -49 -12 -95 -17 -151
-17 -334 -59 -507 -116 -41 -14 -90 -29 -109 -34 -18 -5 -38 -13 -44 -19 -6
-6 -19 -11 -29 -11 -16 0 -33 -6 -123 -45 -80 -35 -306 -147 -336 -168 -19
-13 -41 -26 -49 -30 -8 -4 -28 -16 -45 -27 -16 -11 -37 -23 -45 -27 -101 -48
-371 -267 -565 -458 -168 -166 -396 -467 -485 -640 -6 -11 -19 -33 -30 -50
-10 -16 -35 -64 -56 -105 -20 -41 -40 -82 -45 -90 -5 -8 -12 -22 -15 -30 -3
-8 -19 -42 -35 -75 -16 -33 -29 -67 -29 -76 0 -8 -7 -24 -15 -35 -8 -10 -15
-27 -15 -36 0 -10 -6 -32 -14 -50 -40 -94 -61 -166 -120 -405 -49 -200 -81
-540 -72 -778 6 -172 15 -260 41 -415 8 -47 16 -101 19 -120 4 -33 10 -56 41
-175 8 -27 21 -79 30 -115 9 -36 23 -78 30 -95 7 -16 15 -39 18 -50 3 -11 15
-45 27 -75 12 -30 24 -64 27 -75 10 -36 152 -332 183 -380 11 -16 24 -39 30
-50 6 -11 16 -29 23 -40 7 -11 25 -43 41 -70 37 -62 225 -314 280 -375 156
-173 355 -356 552 -508 38 -29 64 -40 64 -27 0 2 -69 73 -153 157 -84 84 -163
166 -176 182 -60 74 -151 195 -151 201 0 4 -13 24 -30 45 -16 21 -30 41 -30
45 0 3 -11 21 -24 38 -14 18 -29 43 -35 57 -6 14 -21 41 -32 60 -29 48 -51 93
-89 175 -17 39 -36 78 -41 87 -11 22 -37 92 -49 133 -5 17 -19 57 -31 90 -12
33 -25 78 -30 100 -11 54 -28 121 -45 175 -8 25 -14 61 -14 80 0 19 -7 68 -15
110 -36 186 -36 583 0 770 8 42 15 89 15 105 0 16 7 56 16 89 14 57 22 86 61
226 16 57 35 111 59 168 8 18 14 37 14 42 0 10 31 79 98 220 20 41 66 126 104
188 37 62 68 117 68 122 0 5 6 13 14 17 7 4 29 31 47 58 92 139 209 271 405
456 56 53 323 258 354 272 8 4 29 16 45 27 17 11 39 24 50 30 11 6 34 19 50
29 51 33 268 137 340 164 22 8 60 23 85 32 113 43 212 75 235 75 10 0 38 7 64
15 85 27 167 45 204 45 19 0 66 7 104 16 98 24 634 24 741 0 40 -9 89 -16 109
-16 20 0 60 -7 90 -15 29 -8 77 -22 106 -30 30 -8 64 -15 76 -15 12 0 32 -5
44 -12 12 -6 35 -15 52 -19 16 -4 55 -17 85 -29 30 -12 69 -25 85 -29 17 -4
39 -13 50 -19 11 -5 52 -25 90 -42 124 -57 228 -111 290 -151 17 -10 37 -22
45 -26 21 -10 136 -89 206 -142 186 -141 397 -353 539 -541 56 -74 105 -142
109 -150 9 -19 22 -41 67 -110 36 -57 152 -290 183 -370 10 -25 24 -60 32 -78
8 -18 14 -40 14 -48 0 -9 6 -28 14 -42 18 -37 46 -126 46 -148 0 -10 6 -36 14
-59 16 -47 39 -159 61 -300 21 -139 21 -633 0 -720 -8 -33 -14 -75 -15 -93 0
-35 -22 -135 -46 -213 -8 -26 -14 -55 -14 -65 0 -11 -12 -50 -26 -89 -14 -38
-29 -83 -34 -100 -11 -37 -37 -109 -49 -133 -4 -9 -15 -33 -23 -52 -32 -76
-135 -275 -164 -320 -17 -25 -34 -53 -38 -61 -18 -37 -92 -145 -113 -167 -7
-8 -27 -35 -45 -60 -17 -26 -34 -49 -38 -52 -3 -3 -45 -51 -94 -108 -49 -56
-94 -106 -101 -110 -7 -4 -46 -38 -87 -77 -75 -71 -160 -144 -184 -158 -8 -4
-14 -12 -14 -17 0 -15 27 -12 44 5 8 8 17 15 21 15 4 0 32 20 63 43 31 24 75
55 98 70 22 14 61 42 86 64 25 21 67 56 94 77 157 126 430 430 554 616 8 12
29 41 45 64 36 50 53 76 62 96 4 8 25 47 48 85 23 39 69 129 104 200 34 72 69
143 77 158 7 16 14 35 14 42 0 8 7 31 16 52 45 105 62 153 74 203 21 84 33
127 46 158 8 18 14 40 14 50 0 9 7 50 15 90 8 39 22 105 30 145 8 39 15 90 15
112 0 22 7 90 15 150 8 61 15 162 15 225 0 136 -25 427 -46 521 -8 37 -14 79
-14 95 0 15 -7 55 -16 88 -8 34 -22 88 -30 121 -26 102 -46 169 -60 203 -8 18
-14 40 -14 50 0 9 -7 26 -15 36 -8 11 -15 29 -15 41 0 12 -7 30 -15 41 -8 10
-15 27 -15 37 0 16 -106 248 -131 287 -5 8 -11 21 -14 28 -13 32 -16 39 -35
67 -11 17 -24 39 -30 50 -6 11 -19 34 -30 50 -11 17 -23 37 -27 45 -27 56
-246 347 -323 430 -149 159 -190 199 -325 315 -38 33 -81 70 -95 83 -14 12
-28 22 -33 22 -4 0 -52 33 -105 73 -103 76 -128 93 -152 104 -8 4 -33 18 -55
32 -91 58 -335 179 -455 226 -25 9 -56 22 -70 27 -14 6 -38 14 -55 18 -16 5
-55 18 -85 30 -30 12 -73 25 -95 29 -23 4 -46 11 -53 15 -7 4 -33 11 -60 16
-26 5 -99 21 -162 34 -63 14 -129 26 -147 26 -17 0 -60 6 -95 14 -72 16 -333
23 -578 16z"/>
<path d="M7600 8289 c-25 -5 -85 -13 -135 -18 -49 -4 -105 -14 -122 -20 -73
-25 -100 -33 -138 -42 -39 -10 -117 -46 -185 -87 -19 -12 -49 -28 -66 -36 -18
-8 -49 -29 -70 -48 -22 -19 -59 -49 -84 -68 -68 -52 -86 -69 -143 -139 -120
-148 -126 -158 -195 -296 -52 -105 -69 -147 -82 -205 -4 -19 -12 -46 -18 -60
-18 -40 -42 -237 -42 -335 1 -94 29 -294 50 -355 28 -81 33 -96 37 -125 3 -16
9 -34 13 -40 6 -9 73 -131 107 -195 28 -54 177 -233 220 -266 21 -15 45 -35
54 -43 57 -58 137 -111 264 -176 28 -14 57 -30 65 -34 22 -12 80 -32 120 -41
19 -4 46 -12 60 -18 77 -33 168 -45 360 -45 192 0 283 12 360 45 14 6 41 14
60 18 30 7 73 21 115 37 6 2 37 19 70 38 33 18 79 43 101 55 23 11 73 47 110
78 38 32 86 70 107 86 43 33 192 213 220 266 7 14 35 65 62 114 26 49 51 103
55 120 8 30 17 58 41 129 21 58 48 260 49 352 0 98 -24 295 -42 335 -6 14 -14
41 -18 60 -13 58 -30 100 -82 205 -64 129 -98 184 -145 233 -7 7 -33 39 -57
70 -49 62 -67 79 -136 132 -25 19 -62 49 -84 68 -21 19 -52 40 -70 48 -17 8
-51 26 -76 40 -86 49 -136 73 -175 83 -38 9 -65 17 -137 42 -18 6 -73 15 -123
20 -49 5 -114 14 -144 19 -62 11 -68 11 -131 -1z"/>
<path d="M9208 93 c12 -2 30 -2 40 0 9 3 -1 5 -23 4 -22 0 -30 -2 -17 -4z"/>
</g>
</svg>`;


function simboloDoAgente(id) {
  return { hermes: SVG_SIMBOLO_MIRIEL, prometeu: SVG_SIMBOLO_LUMEN, hefesto: SVG_SIMBOLO_NOVA }[id]
    ?? SVG_SIMBOLO_LUMEN;
}

function htmlHud() {
  return `
    <div class="panteao-hud panteao-hud--compacta" id="panteao-hud" role="group" aria-label="Agentes do Panteão">
      ${AGENTES.map((a) => `
        <div class="agente-simbolo" data-agente-card="${a.id}"
             style="--agente: ${a.cor}"
             aria-label="${escapar(a.nome)} — ${escapar(a.funcao)}">
          <span class="agente-simbolo__glifo" aria-hidden="true">${simboloDoAgente(a.id)}</span>
          <span class="agente-simbolo__nome">${escapar(a.nome)}</span>
          <span class="agente-simbolo__estado" data-agente-estado="${a.id}" aria-live="polite"></span>
        </div>
      `).join('')}
    </div>
  `;
}

function htmlEstadoVazio() {
  return `
    <div class="panteao-vazio">
      <p class="panteao-vazio__frase">Qual é a diretriz de hoje?</p>
    </div>
  `;
}

/**
 * Sugestões coladas acima da barra de entrada — padrão ChatGPT. Vivem aqui,
 * não dentro do estado vazio: aparecem sempre que o campo está sem texto,
 * conversa tendo começado ou não, e somem com a digitação.
 *
 * O ícone é sobre o ASSUNTO da pergunta (financeiro, agenda, insight geral
 * — projetos/clientes/WhatsApp entram como categorias novas quando essas
 * frentes existirem), não sobre qual agente responde — antes cada ícone
 * era fixo por agente (raio=Miriel, gráfico=Lux, chave=Nova), o que não
 * fazia sentido pra pergunta em si. Nomear o agente no texto também foi
 * tirado — o card de destino já deixa isso implícito quando for o caso.
 *
 * Ainda são frases fixas escritas por mim, sorteadas 2 por vez — "geradas
 * pela Miriel de acordo com os afazeres do dia" (ideia já registrada nas
 * pendências) é um passo futuro, não isto aqui.
 */
const SUGESTOES_POOL = [
  { categoria: 'agenda', icone: SVG_CALENDARIO, texto: 'Resuma meus compromissos de hoje' },
  { categoria: 'agenda', icone: SVG_CALENDARIO, texto: 'O que ainda falta fazer hoje?' },
  { categoria: 'financeiro', icone: SVG_GRAFICO, texto: 'Qual o saldo projetado do mês?' },
  { categoria: 'financeiro', icone: SVG_GRAFICO, texto: 'Teve gasto fora do padrão essa semana?' },
  { categoria: 'insight', icone: SVG_INSIGHT, texto: 'Verificar status de periféricos e rotinas' },
  { categoria: 'insight', icone: SVG_INSIGHT, texto: 'Alguma rotina atrasada?' }
];

/**
 * Só existem numa conversa nova — igual ao Gemini: assim que a primeira
 * mensagem é enviada, somem para sempre, mesmo que o campo volte a ficar
 * vazio depois. Não são "sugestões de digitação"; são o convite inicial.
 * Pequenas, no canto inferior esquerdo, fundo transparente — não competem
 * visualmente com o campo de texto abaixo.
 */
function htmlSugestoesInline() {
  if (mensagens.length) return '';
  const escolhidas = [...SUGESTOES_POOL].sort(() => Math.random() - 0.5).slice(0, 2);
  return `
    <div class="sugestoes-inline" data-regiao="sugestoes">
      ${escolhidas.map((s) => `
        <button class="sugestao-inline" type="button" data-sugestao="${escapar(s.texto)}">
          <span class="sugestao-inline__icone" aria-hidden="true">${s.icone}</span>
          <span>${escapar(s.texto)}</span>
        </button>
      `).join('')}
    </div>
  `;
}

function htmlAnexoDaMensagem(anexo) {
  if (!anexo) return '';
  return `
    <div class="msg-anexo">
      <span class="msg-anexo__nome">${escapar(anexo.nome)}</span>
      <span class="msg-anexo__meta">${tamanhoLegivel(anexo.tamanho)}</span>
    </div>`;
}

function htmlMensagemUsuario(msg) {
  return `
    <div class="msg msg--usuario">
      <div class="msg__bolha">
        ${htmlAnexoDaMensagem(msg.anexo)}
        ${msg.texto ? `<p class="msg__texto">${formatarCorpo(msg.texto)}</p>` : ''}
      </div>
    </div>
  `;
}

/** Um nó da timeline: ícone (relógio ou terminal) + texto cinza. */
function htmlPassoTimeline(passo) {
  const icone = passo.tipo === 'comando' ? SVG_TERMINAL : SVG_RELOGIO;
  return `
    <div class="timeline__no">
      <span class="timeline__icone" aria-hidden="true">${icone}</span>
      <span class="timeline__texto">${escapar(passo.texto)}</span>
    </div>
  `;
}

/**
 * Cabeçalho retrátil da timeline. Enquanto em curso, fica aberta sozinha
 * para o passo a passo ser acompanhado ao vivo; ao concluir, fecha e vira
 * um resumo — "Executou um comando" se algum passo foi comando, senão
 * "Pensou por X.Xs".
 */
function htmlTimeline(msg) {
  const { passos, concluido, tempoTotal } = msg.timeline;
  const teveComando = passos.some((p) => p.tipo === 'comando');
  const rotulo = teveComando ? 'Executou um comando' : `Pensou por ${tempoTotal.toFixed(1)}s`;
  const aberta = !concluido;

  return `
    <button class="timeline__btn" type="button" data-timeline-toggle="${msg.id}"
            aria-expanded="${aberta}">
      <span class="timeline__rotulo">${rotulo}</span>
      <span class="timeline__seta ${aberta ? 'timeline__seta--aberta' : ''}" aria-hidden="true">&#8964;</span>
    </button>
    <div class="timeline__corpo" data-timeline-corpo="${msg.id}" ${aberta ? '' : 'hidden'}>
      ${passos.map(htmlPassoTimeline).join('')}
    </div>
  `;
}

function htmlMensagemAgente(msg) {
  const a = agentePorId(msg.agenteId);
  // corpo só aparece quando a timeline concluiu — antes disso só o
  // progresso é visível, como nas ferramentas de agente (Cursor/Claude)
  const mostrarCorpo = !msg.timeline || msg.timeline.concluido;

  return `
    <div class="msg msg--agente" style="--agente: ${a.cor}">
      <p class="msg__autor">${escapar(a.nome)}</p>

      ${msg.timeline ? htmlTimeline(msg) : ''}

      ${mostrarCorpo ? `<div class="msg__corpo">${formatarCorpo(msg.texto)}</div>` : ''}

      ${mostrarCorpo && msg.acoes?.length ? `
        <div class="msg__acoes">
          ${msg.acoes.map((ac) => `
            <button class="chip-acao" type="button" data-acao-chip="${escapar(ac.tipo)}">
              ${ac.icone ? `<span class="chip-acao__icone" aria-hidden="true">${ac.icone}</span>` : '<span aria-hidden="true">+</span>'}
              ${escapar(ac.label)}
            </button>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function htmlFeed() {
  if (!mensagens.length) return htmlEstadoVazio();
  return mensagens.map((m) => (
    m.autor === 'usuario' ? htmlMensagemUsuario(m) : htmlMensagemAgente(m)
  )).join('');
}

function htmlGavetaAnexos() {
  return `
    <div class="anexo-sheet" data-regiao="anexo-sheet" hidden>
      <div class="anexo-sheet__fundo" data-anexo-fechar aria-hidden="true"></div>
      <div class="anexo-sheet__painel" role="dialog" aria-modal="true" aria-label="Anexar arquivo">
        <div class="anexo-sheet__alca" aria-hidden="true"></div>

        <ul class="anexo-sheet__lista">
          ${ACOES_ANEXO.map((a) => `
            <li>
              <button class="anexo-sheet__item" type="button" data-anexo-acao="${a.id}">
                <span class="anexo-sheet__item-icone" aria-hidden="true">${a.icone}</span>
                <span class="anexo-sheet__item-texto"><strong>${escapar(a.rotulo)}</strong></span>
              </button>
            </li>
          `).join('')}
        </ul>
      </div>
    </div>
  `;
}

function htmlChipAnexoPendente() {
  if (!anexoPendente) return '';
  return `
    <div class="anexo-pendente">
      <span class="anexo-pendente__nome">${escapar(anexoPendente.nome)}</span>
      <span class="anexo-pendente__meta">${tamanhoLegivel(anexoPendente.tamanho)}</span>
      <button class="anexo-pendente__remover" type="button" data-remover-anexo
              aria-label="Remover anexo">&times;</button>
    </div>
  `;
}

/* ==================================================================
   6. TRANSCRIÇÃO DE VOZ AO VIVO — Web Speech API nativa, sem backend
   Diferente de gravar um áudio (que produz um arquivo), isto converte a
   fala em texto em tempo real, direto no campo de mensagem. É nativo do
   navegador — Chrome e Edge suportam via o prefixo `webkit`; Firefox e
   Safari não implementam a API, e o botão avisa isso em vez de falhar
   em silêncio.
   ================================================================== */
let reconhecimento = null;
let ouvindo = false;

function iniciarTranscricao(view) {
  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionAPI) {
    console.warn('[panteão] reconhecimento de voz indisponível neste navegador (Chrome/Edge suportam).');
    return;
  }

  const campo = view.querySelector('[data-campo-texto]');
  const baseTexto = campo.value ? `${campo.value.trim()} ` : '';

  reconhecimento = new SpeechRecognitionAPI();
  reconhecimento.lang = 'pt-BR';
  reconhecimento.continuous = true;
  reconhecimento.interimResults = true;

  reconhecimento.onresult = (evento) => {
    // Sempre do zero, não a partir de evento.resultIndex: cada evento só
    // devolve o que mudou DESDE O ÚLTIMO evento, mas um resultado "final"
    // (uma frase já reconhecida) continua morando no índice antigo dele em
    // evento.results. Começar em resultIndex pulava essas frases antigas e
    // cada nova sentença sobrescrevia a anterior — era o reset que você viu.
    let final = '';
    let parcial = '';
    for (let i = 0; i < evento.results.length; i += 1) {
      const resultado = evento.results[i];
      if (resultado.isFinal) final += resultado[0].transcript;
      else parcial += resultado[0].transcript;
    }
    campo.value = baseTexto + final + parcial;
    ajustarAlturaTextarea(campo);
    // dispara 'input' para o listener existente atualizar o botão de enviar
    campo.dispatchEvent(new Event('input', { bubbles: true }));
  };

  reconhecimento.onerror = (evento) => {
    console.warn('[panteão] erro no reconhecimento de voz:', evento.error);
    pararTranscricao(view);
  };

  // a API encerra sozinha após um silêncio — o botão precisa acompanhar
  reconhecimento.onend = () => { if (ouvindo) pararTranscricao(view); };

  reconhecimento.start();
  ouvindo = true;
  const botao = view.querySelector('[data-acao="gravar"]');
  botao?.classList.add('is-recording');
  const textarea = view.querySelector('[data-campo-texto]');
  if (textarea) textarea.placeholder = 'Ouvindo…';
}

function pararTranscricao(view) {
  ouvindo = false;
  try { reconhecimento?.stop(); } catch { /* já parado */ }
  reconhecimento = null;
  view.querySelector('[data-acao="gravar"]')?.classList.remove('is-recording');
  const textarea = view.querySelector('[data-campo-texto]');
  if (textarea) textarea.placeholder = 'Perguntar ao Panteão…';
}

function atualizarBarraDeAnexo(view) {
  const area = view.querySelector('[data-regiao="anexo-pendente"]');
  if (area) area.innerHTML = htmlChipAnexoPendente();
}

/* ==================================================================
   7. HUD — acender/apagar o pulso de um agente
   ================================================================== */
/**
 * Um agente "aceso" no HUD não é mais exclusivo — na colaboração multi-
 * agente, dois ou três podem brilhar ao mesmo tempo (um respondendo,
 * outro "considerando"). `ativarAgente`/`desativarAgente` mexem só no
 * card daquele agente, sem apagar os outros.
 */
function ativarAgente(agenteId, estadoTexto) {
  if (!raiz) return;
  const card = raiz.querySelector(`[data-agente-card="${agenteId}"]`);
  const rotulo = raiz.querySelector(`[data-agente-estado="${agenteId}"]`);
  if (!card) return;
  card.classList.add('is-responding');
  if (rotulo) rotulo.textContent = estadoTexto ?? '';
}

function desativarAgente(agenteId) {
  if (!raiz) return;
  const card = raiz.querySelector(`[data-agente-card="${agenteId}"]`);
  const rotulo = raiz.querySelector(`[data-agente-estado="${agenteId}"]`);
  if (!card) return;
  card.classList.remove('is-responding');
  if (rotulo) rotulo.textContent = '';
}

/** Apaga o brilho dos 3 de uma vez — usado ao encerrar uma rodada inteira. */
function desativarTodosAgentes() {
  AGENTES.forEach((a) => desativarAgente(a.id));
}

/* ==================================================================
   8. INDICADOR DO HEADER
   ================================================================== */
function anunciar(label, tone) {
  document.dispatchEvent(new CustomEvent('sanco:status', { detail: { label, tone } }));
}
function statusOcioso() {
  anunciar(mensagens.length ? 'Conversa em aberto' : 'Nenhuma conversa aberta',
            mensagens.length ? 'secure' : 'offline');
}

/* ==================================================================
   9. RENDERIZAÇÃO INCREMENTAL
   ================================================================== */
function redesenharFeed() {
  const feed = raiz?.querySelector('[data-regiao="feed"]');
  if (!feed) return;
  feed.innerHTML = htmlFeed();
  feed.scrollTop = feed.scrollHeight;
}

/** Atualiza só a mensagem de um fluxo em curso, sem redesenhar tudo. */
function redesenharMensagem(msgId) {
  if (!raiz) return;
  // mais simples e seguro que localizar o nó exato: como a timeline em
  // curso costuma ser a última mensagem, redesenhar o feed inteiro aqui
  // tem custo desprezível para o tamanho de conversa deste app
  redesenharFeed();
}

/* ==================================================================
   10. API PÚBLICA — iniciarFluxo / adicionarPassoTimeline / finalizarResposta
   ================================================================== */

/**
 * Abre uma mensagem de agente em progresso: acende o pulso no HUD e cria
 * a timeline vazia. Chame adicionarPassoTimeline() e depois finalizarResposta()
 * para fechá-la.
 *
 * @param {string} agenteNome id ('hermes') ou nome ('Hermes') do agente
 * @returns {number} id da mensagem, para referência
 */
function iniciarFluxo(agenteNome) {
  const a = agentePorNome(agenteNome);
  const msg = {
    id: proximoId++,
    autor: a.id,
    agenteId: a.id,
    texto: '',
    acoes: [],
    timeline: { passos: [], concluido: false, tempoTotal: 0, iniciadoEm: Date.now() }
  };
  mensagens.push(msg);
  fluxoAtual = { msgId: msg.id, agenteId: a.id, iniciadoEm: msg.timeline.iniciadoEm };

  ativarAgente(a.id, 'Pensando…');
  anunciar(`${a.nome} está pensando`, 'pending');
  redesenharFeed();

  return msg.id;
}

/**
 * Acrescenta um passo à timeline do fluxo em curso.
 * @param {string} texto
 * @param {'pensamento'|'comando'} tipo
 */
function adicionarPassoTimeline(texto, tipo = 'pensamento') {
  if (!fluxoAtual) {
    console.warn('[panteão] adicionarPassoTimeline chamado sem iniciarFluxo() antes.');
    return;
  }
  const msg = mensagens.find((m) => m.id === fluxoAtual.msgId);
  if (!msg) return;

  msg.timeline.passos.push({
    texto,
    tipo: tipo === 'comando' ? 'comando' : 'pensamento'
  });

  if (tipo === 'comando') ativarAgente(fluxoAtual.agenteId, 'Executando…');
  redesenharMensagem(msg.id);
}

/**
 * Fecha o fluxo em curso: apaga o pulso do HUD, imprime a resposta final
 * e anexa os chips de ação.
 * @param {string} textoFinal
 * @param {Array<{label: string, tipo: string, icone?: string}>} acoes
 */
function finalizarResposta(textoFinal, acoes = []) {
  if (!fluxoAtual) {
    console.warn('[panteão] finalizarResposta chamado sem iniciarFluxo() antes.');
    return;
  }
  const msg = mensagens.find((m) => m.id === fluxoAtual.msgId);
  if (msg) {
    msg.texto = textoFinal;
    msg.acoes = acoes;
    msg.timeline.concluido = true;
    msg.timeline.tempoTotal = (Date.now() - fluxoAtual.iniciadoEm) / 1000;
  }

  desativarAgente(fluxoAtual.agenteId);
  statusOcioso();
  fluxoAtual = null;
  redesenharFeed();
}

/* ==================================================================
   11. SIMULAÇÃO INTERNA — usa a API pública acima, ponta a ponta
   Sem backend ainda: aiOrchestrator.js (backend/services/) é quem vai
   decidir de verdade quem lidera, quem concorda e quem discorda. O que
   está aqui é só o formato da interação — o "quem fala quando" —, não
   um motor de consenso real. Cada linha de texto simulada avisa isso.
   ================================================================== */
async function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const PASSOS_PADRAO = [
  ['Interpretando a solicitação e identificando o domínio do pedido.', 'pensamento'],
  ['Verificando dado local relevante disponível.', 'comando']
];

/**
 * Um turno completo de UM agente: acende o pulso, passa pela timeline,
 * imprime a resposta. Reaproveitado tanto pelo líder quanto por qualquer
 * agente que entre depois na mesma rodada.
 *
 * @param {string} agenteId
 * @param {string} textoFinal já pronto — quem chama decide o que ele diz
 * @param {Array} acoes
 */
async function turnoAgente(agenteId, textoFinal, acoes = []) {
  iniciarFluxo(agenteId);
  for (const [texto, tipo] of PASSOS_PADRAO) {
    await esperar(350 + Math.random() * 300);
    if (!raiz) return;
    adicionarPassoTimeline(texto, tipo);
  }
  await esperar(400 + Math.random() * 300);
  if (!raiz) return;
  finalizarResposta(textoFinal, acoes);
}

/** O texto de demonstração de cada agente — nunca finge ser resposta real. */
function respostaDemo(agenteId, textoUsuario) {
  const a = agentePorId(agenteId);
  const texto =
    `Ainda não estou conectado a um modelo de verdade — esta é uma resposta de `
    + `demonstração da interface. Quando o backend existir, é aqui que a resposta `
    + `real de **${a.nome}** aparece.`;

  const minusc = textoUsuario.toLowerCase();
  const acoes = minusc.includes('rotina')
    ? [{ label: 'Confirmar na Rotina', tipo: 'confirmar-rotina' }]
    : minusc.includes('gasto') || minusc.includes('despesa') || minusc.includes('financ')
    ? [{ label: 'Abrir no Financeiro', tipo: 'abrir-financeiro', icone: SVG_GRAFICO }]
    : [];

  return { texto, acoes };
}

/**
 * Um agente "considera" a resposta do líder sem falar — pulso breve, sem
 * bolha de mensagem. É o "ficam quietas se concordam" da vitrine: na
 * maioria das vezes é isto que os outros dois fazem.
 */
async function considerarSilenciosamente(agenteId) {
  if (!raiz) return;
  ativarAgente(agenteId, 'Analisando…');
  await esperar(500 + Math.random() * 500);
  if (!raiz) return;
  desativarAgente(agenteId);
}

/**
 * Conversa em modo 'individual': só o agente daquela conversa responde.
 * Nada de colaboração — é a leitura literal de "para somente 1 não
 * existe outra coisa".
 */
/**
 * Miriel é a primeira conectada de verdade — Lux e Nova continuam
 * simuladas até ganharem sua própria rota. Sem orquestração ainda: isto
 * só roda em conversa individual com ela, nunca dentro do Conselho.
 */
async function turnoMirielReal(textoUsuario) {
  iniciarFluxo('hermes');
  adicionarPassoTimeline('Perguntando à Miriel (Gemini)…', 'comando');

  const conversa = conversas.find((c) => c.id === conversaAtivaId);

  try {
    if (conversa) await garantirConversaPersistida(conversa);

    const resposta = await fetch(`${URL_BACKEND}/api/panteao/miriel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversaId: conversa?.dbId ?? null, texto: textoUsuario })
    });

    if (!resposta.ok) {
      const corpo = await resposta.json().catch(() => ({}));
      throw new Error(corpo.erro || `o backend respondeu ${resposta.status}`);
    }

    const { texto, uso } = await resposta.json();
    registrarUsoTokens(uso);
    finalizarResposta(texto, []);
  } catch (erro) {
    // sem backend rodando, sem GEMINI_API_KEY configurada, sem internet —
    // qualquer um desses cai aqui, e a pessoa vê o motivo, não silêncio
    finalizarResposta(
      `Não consegui falar com o backend agora (${erro.message}). `
      + `Confirme que ele está rodando em ${URL_BACKEND} (backend/npm start) `
      + `e que a GEMINI_API_KEY está no backend/.env.`,
      []
    );
  }
}

async function simularIndividual(agenteId, textoUsuario) {
  if (agenteId === 'hermes') return turnoMirielReal(textoUsuario);
  const { texto, acoes } = respostaDemo(agenteId, textoUsuario);
  await turnoAgente(agenteId, texto, acoes);
}

/**
 * Conversa em modo 'multi' (o Conselho): o líder responde primeiro — quem
 * for mencionado explicitamente, senão a heurística de assunto decide.
 * Os outros dois, em seguida, cada um decide sozinho se fica quieto
 * (concorda) ou entra com uma fala curta (discorda) — é vitrine, não um
 * motor de consenso de verdade; a proporção é só para a demonstração
 * parecer viva, não uma regra de negócio real.
 */
async function simularConselho(liderId, textoUsuario, participantes = null) {
  const { texto, acoes } = respostaDemo(liderId, textoUsuario);
  await turnoAgente(liderId, texto, acoes);
  if (!raiz) return;

  const time = participantes ? AGENTES.filter((a) => participantes.includes(a.id)) : AGENTES;
  const outros = time.filter((a) => a.id !== liderId);
  for (const a of outros) {
    if (!raiz) return;
    const discorda = Math.random() < 0.3;   // ~30% "entra na conversa"

    if (!discorda) {
      await considerarSilenciosamente(a.id);
      continue;
    }

    const textoDivergente =
      `(Resposta de demonstração) Vale complementar o que **${agentePorId(liderId).nome}** `
      + `trouxe — quando o backend existir, é aqui que ${a.nome} entra de verdade na `
      + `discussão, só quando tiver algo a acrescentar ou discordar.`;
    await turnoAgente(a.id, textoDivergente, []);
  }
}

/* ==================================================================
   11.1 GAVETA DE ANEXOS
   ================================================================== */
function abrirGavetaAnexos() {
  if (!gaveta) return;
  gaveta.hidden = false;
  // reflow antes de aplicar a classe, para a transição de entrada rodar
  void gaveta.offsetWidth;
  gaveta.classList.add('is-aberta');
}

function fecharGavetaAnexos() {
  if (!gaveta || gaveta.hidden) return;
  gaveta.classList.remove('is-aberta');
  // espera a transição de saída antes de tirar do fluxo do documento
  setTimeout(() => { if (gaveta) gaveta.hidden = true; }, 200);
}

/**
 * Redesenha o bloco de sugestões — chamado só quando `mensagens` muda
 * (enviar a primeira mensagem), nunca a cada tecla digitada.
 */
function atualizarSugestoes(view) {
  const bloco = view.querySelector('[data-regiao="sugestoes"]');
  if (bloco) bloco.outerHTML = htmlSugestoesInline();
}

/* ==================================================================
   11.3 MENU DE CONVERSA (Renomear/Excluir) — ancorado ao body
   Antes era um dropdown position:absolute dentro da lista — ficava
   cortado pela borda da lista quando a conversa estava perto do fim
   (overflow-y:auto do container escondia a metade do menu). Agora segue
   o MESMO padrão da gaveta/sidebar: nó próprio anexado ao <body>, tela
   inteira, sempre visível por cima de tudo.
   ================================================================== */
let menuConversaPopover = null;
let conversaAtivaPopover = null;
let aoClicarMenuConversa = null;
let aoTeclarMenuConversa = null;

/** Seleção em andamento no popover "Personalizado" — Set de agenteId. */
let selecaoPersonalizada = new Set();

function htmlMenuConversa(id) {
  const c = conversas.find((x) => x.id === id);
  if (!c) return '';
  return `
    <div class="conversa-menu-popover__fundo" data-menu-conversa-fechar aria-hidden="true"></div>
    <div class="conversa-menu-popover__painel" role="dialog" aria-modal="true"
         aria-label="Opções de ${escapar(c.titulo)}">
      <p class="conversa-menu-popover__titulo">${escapar(c.titulo)}</p>
      <button class="conversa-menu-popover__item" type="button" data-renomear-id="${c.id}">
        ${SVG_LAPIS}<span>Renomear</span>
      </button>
      <button class="conversa-menu-popover__item is-perigo" type="button" data-excluir-id="${c.id}">
        ${SVG_LIXEIRA}<span>Excluir</span>
      </button>
    </div>
  `;
}

/**
 * @param {string} id
 * @param {{x: number, y: number}|null} pos — se vier, o menu abre ANCORADO
 *        nesse ponto (onde o dedo segurou / o clique direito aconteceu) em
 *        vez de centralizado na tela.
 */
function abrirMenuConversa(id, pos = null) {
  if (!menuConversaPopover) return;
  conversaAtivaPopover = id;
  menuConversaPopover.innerHTML = htmlMenuConversa(id).trim();
  menuConversaPopover.hidden = false;
  void menuConversaPopover.offsetWidth;
  menuConversaPopover.classList.add('is-aberto');

  const painel = menuConversaPopover.querySelector('.conversa-menu-popover__painel');
  if (painel && pos) {
    painel.classList.add('conversa-menu-popover__painel--ancorado');
    // medidas reais do painel, já renderizado (mesmo com opacity:0 durante
    // a transição, offsetWidth/Height continuam corretos)
    const largura = painel.offsetWidth || 220;
    const altura = painel.offsetHeight || 160;
    const margem = 12;
    const left = Math.min(Math.max(margem, pos.x), window.innerWidth - largura - margem);
    const top = Math.min(Math.max(margem, pos.y), window.innerHeight - altura - margem);
    painel.style.left = `${left}px`;
    painel.style.top = `${top}px`;
  }
}

/** Popover "Personalizado": escolher 2 ou 3 agentes pra montar um conselho
 *  restrito, no lugar do Conselho completo (3) ou de uma conversa
 *  individual (1). Reaproveita o mesmo popover de conversa — não faz
 *  sentido dois nós separados pra um modal simples como este. */
function htmlPersonalizadoPopover() {
  return `
    <div class="conversa-menu-popover__fundo" data-menu-conversa-fechar aria-hidden="true"></div>
    <div class="conversa-menu-popover__painel" role="dialog" aria-modal="true"
         aria-label="Criar conselho personalizado">
      <p class="conversa-menu-popover__titulo">Quem participa?</p>
      <p class="conversa-menu-popover__nota">Escolha pelo menos 2 — um só já é conversa individual.</p>
      <div class="personalizado-lista">
        ${AGENTES.map((a) => `
          <button class="personalizado-lista__item ${selecaoPersonalizada.has(a.id) ? 'is-selecionado' : ''}"
                  type="button" data-toggle-personalizado="${a.id}" style="--agente:${a.cor}">
            <span class="personalizado-lista__ponto" aria-hidden="true"></span>
            <span class="personalizado-lista__nome">${escapar(a.nome)}</span>
            ${selecaoPersonalizada.has(a.id) ? '<span aria-hidden="true">&#10003;</span>' : ''}
          </button>
        `).join('')}
      </div>
      <button class="btn btn--gold conversa-menu-popover__confirmar" type="button"
              data-acao="confirmar-personalizado" ${selecaoPersonalizada.size < 2 ? 'disabled' : ''}>
        Criar conversa
      </button>
    </div>
  `;
}

function abrirPersonalizadoPopover() {
  if (!menuConversaPopover) return;
  selecaoPersonalizada = new Set();
  menuConversaPopover.innerHTML = htmlPersonalizadoPopover().trim();
  menuConversaPopover.hidden = false;
  void menuConversaPopover.offsetWidth;
  menuConversaPopover.classList.add('is-aberto');
}

/**
 * Tela de detalhe do contador de tokens. Só mostra o que existe de
 * verdade — usado nesta sessão, e desde quando essa sessão começou. Cota
 * do plano, uso desde a renovação e data de renovação NÃO aparecem: a API
 * da Gemini não expõe isso automaticamente, e esse número nunca foi
 * configurado em lugar nenhum do projeto. Mostrar um total fixo/restante
 * ali seria inventar dado, então fica um aviso honesto no lugar até
 * existir uma fonte real (ou até você me passar o número do seu plano
 * pra eu deixar fixo, sabendo que é um valor digitado, não consultado).
 */
function htmlTokensPopover() {
  const inicio = sessaoIniciadaEm.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  return `
    <div class="conversa-menu-popover__fundo" data-tokens-fechar aria-hidden="true"></div>
    <div class="conversa-menu-popover__painel" role="dialog" aria-modal="true" aria-label="Uso de tokens">
      <p class="conversa-menu-popover__titulo">Tokens</p>
      <dl class="tokens-detalhe">
        <div><dt>Usado nesta sessão</dt><dd>${tokensUsados.total.toLocaleString('pt-BR')}</dd></div>
        <div><dt>Sessão iniciada em</dt><dd>${inicio}</dd></div>
      </dl>
      <p class="conversa-menu-popover__nota">
        Cota do plano, uso desde a renovação e data de renovação ainda não aparecem aqui —
        a Gemini não expõe isso sozinha, e esse número nunca foi configurado no projeto.
        Me passe o valor do seu plano que eu deixo fixo aqui até existir uma forma de consultar de verdade.
      </p>
    </div>
  `;
}

function abrirTokensPopover() {
  if (!menuConversaPopover) return;
  menuConversaPopover.innerHTML = htmlTokensPopover().trim();
  menuConversaPopover.hidden = false;
  void menuConversaPopover.offsetWidth;
  menuConversaPopover.classList.add('is-aberto');
}

function fecharMenuConversa() {
  if (!menuConversaPopover || menuConversaPopover.hidden) return;
  menuConversaPopover.classList.remove('is-aberto');
  setTimeout(() => { if (menuConversaPopover) menuConversaPopover.hidden = true; }, 160);
  conversaAtivaPopover = null;
}

function montarMenuConversa() {
  const molde = document.createElement('div');
  molde.className = 'conversa-menu-popover';
  molde.hidden = true;
  menuConversaPopover = molde;
  document.body.appendChild(menuConversaPopover);

  aoClicarMenuConversa = (evento) => {
    if (evento.target.closest('[data-menu-conversa-fechar]')) return fecharMenuConversa();
    if (evento.target.closest('[data-tokens-fechar]')) return fecharMenuConversa();

    const toggle = evento.target.closest('[data-toggle-personalizado]');
    if (toggle) {
      const id = toggle.dataset.togglePersonalizado;
      if (selecaoPersonalizada.has(id)) selecaoPersonalizada.delete(id);
      else selecaoPersonalizada.add(id);
      menuConversaPopover.innerHTML = htmlPersonalizadoPopover().trim();
      return;
    }

    if (evento.target.closest('[data-acao="confirmar-personalizado"]')) {
      if (selecaoPersonalizada.size < 2) return;
      const ids = [...selecaoPersonalizada];
      fecharMenuConversa();
      criarConversaPersonalizada(ids);
      return;
    }

    const renomear = evento.target.closest('[data-renomear-id]');
    if (renomear) {
      fecharMenuConversa();
      renomeandoId = renomear.dataset.renomearId;
      redesenharPainelSidebar();
      abrirSidebar();
      requestAnimationFrame(() => {
        const campo = sidebar?.querySelector('[data-renomear-campo]');
        campo?.focus();
        campo?.select();
      });
      return;
    }

    const excluir = evento.target.closest('[data-excluir-id]');
    if (excluir) {
      fecharMenuConversa();
      excluirConversa(excluir.dataset.excluirId);
    }
  };

  aoTeclarMenuConversa = (evento) => {
    if (evento.key === 'Escape') fecharMenuConversa();
  };

  menuConversaPopover.addEventListener('click', aoClicarMenuConversa);
  document.addEventListener('keydown', aoTeclarMenuConversa);
}

function desmontarMenuConversa() {
  if (menuConversaPopover) {
    menuConversaPopover.removeEventListener('click', aoClicarMenuConversa);
    menuConversaPopover.remove();
  }
  document.removeEventListener('keydown', aoTeclarMenuConversa);
  menuConversaPopover = null;
  conversaAtivaPopover = null;
  aoClicarMenuConversa = null;
  aoTeclarMenuConversa = null;
}

/* ==================================================================
   11.2 BARRA LATERAL DE CONVERSAS
   ================================================================== */

/** Estado de "renomeando agora" — só uma conversa por vez, óbvio. */
let renomeandoId = null;

/** A busca da sidebar começa fechada — só o ícone aparece até tocar nele. */
let buscaSidebarAberta = false;

/** Filtro ativo da lista "Recentes": 'todas' | 'multi' | id de um agente. */
let filtroConversas = 'todas';

/** A lista de opções do filtro começa fechada — só a ativa aparece. */
let filtrosConversaAbertos = false;

/** Um item da lista — vira campo de edição quando é o que está sendo renomeado.
 *  O card ocupa a linha inteira (sem botão de menu ao lado) — segurar em
 *  cima dele (ou clicar com o botão direito, no desktop) abre o menu de
 *  Renomear/Excluir, ancorado bem onde o dedo/cursor estava (ver
 *  aoContextMenuSidebar e abrirMenuConversa). */
function htmlItemConversa(c, ponto = null) {
  if (c.id === renomeandoId) {
    return `
      <li class="conversas-lista__linha">
        ${ponto ? `<span class="conversas-lista__ponto" aria-hidden="true" style="background:${ponto}"></span>` : ''}
        <input class="conversas-lista__editar" type="text" data-renomear-campo="${c.id}"
               value="${escapar(c.titulo)}" aria-label="Renomear conversa" autofocus>
      </li>
    `;
  }

  return `
    <li class="conversas-lista__linha">
      <button class="conversas-lista__card conversas-lista__card--cheio ${c.id === conversaAtivaId ? 'is-ativa' : ''}"
              type="button" data-conversa-id="${c.id}"
              aria-label="${escapar(c.titulo)}. Segure para renomear ou excluir.">
        ${ponto ? `<span class="conversas-lista__ponto" aria-hidden="true" style="background:${ponto}"></span>` : ''}
        <span class="conversas-lista__titulo">${escapar(c.titulo)}</span>
      </button>
    </li>
  `;
}

/** Um agente "bate" o filtro se: filtro é 'todas'; é 'conselho' e a
 *  conversa é modo multi (Conselho completo ou personalizado); ou é um
 *  agenteId e a conversa é individual com ele, ou personalizada incluindo
 *  ele. */
function conversaBateFiltro(c, filtro) {
  if (filtro === 'todas') return true;
  if (filtro === 'conselho') return c.modo === 'multi';
  if (c.modo === 'individual') return c.agenteId === filtro;
  if (c.modo === 'multi') return Array.isArray(c.participantes) && c.participantes.includes(filtro);
  return false;
}

/** Lista única "Recentes" — Conselho e conversas individuais juntos,
 *  filtráveis pelos chips (Todas/Conselho/Miriel/Lux/Nova) e pela busca. */
function htmlListaConversas(filtroTexto = '') {
  const termo = filtroTexto.trim().toLowerCase();
  const visiveis = conversas.filter((c) =>
    conversaBateFiltro(c, filtroConversas) && (!termo || c.titulo.toLowerCase().includes(termo))
  );

  if (!visiveis.length) {
    return '<li class="conversas-lista__vazio">Nenhuma conversa encontrada.</li>';
  }

  return visiveis
    .map((c) => htmlItemConversa(c, c.modo === 'individual' ? agentePorId(c.agenteId).cor : null))
    .join('');
}

/** Chevron pequeno — indica que o filtro é retrátil. */
const SVG_CHEVRON_FILTRO = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 6 8 10 12 6"/></svg>`;

/** Filtro retrátil — mostra só a opção ativa (sempre "Todas" ao reabrir a
 *  sidebar); tocar nela revela as outras numa lista solta por baixo. */
function htmlFiltrosConversa() {
  const opcoes = [
    { id: 'todas', rotulo: 'Todas' },
    { id: 'conselho', rotulo: 'Conselho' },
    ...AGENTES.map((a) => ({ id: a.id, rotulo: a.nome, cor: a.cor }))
  ];
  const atual = opcoes.find((o) => o.id === filtroConversas) ?? opcoes[0];

  return `
    <div class="conversas-filtro-retratil">
      <button class="conversas-filtro-retratil__atual" type="button" data-acao="alternar-filtros"
              aria-expanded="${filtrosConversaAbertos}" style="${atual.cor ? `--agente:${atual.cor}` : ''}">
        <span>${escapar(atual.rotulo)}</span>
        <span class="conversas-filtro-retratil__seta ${filtrosConversaAbertos ? 'is-aberta' : ''}" aria-hidden="true">${SVG_CHEVRON_FILTRO}</span>
      </button>
      ${filtrosConversaAbertos ? `
        <div class="conversas-filtro-retratil__lista" role="listbox" aria-label="Filtrar conversas recentes">
          ${opcoes.filter((o) => o.id !== filtroConversas).map((o) => `
            <button class="conversas-filtro-retratil__item" type="button" data-filtro-conversa="${o.id}"
                    style="${o.cor ? `--agente:${o.cor}` : ''}">${escapar(o.rotulo)}</button>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

/** Tudo que fica dentro do painel — separado do wrapper para poder ser
 *  redesenhado sozinho (abrirSidebar, renomear, busca, filtro)
 *  sem recriar o fundo escurecido nem perder a transição de entrada. */
function htmlPainelSidebar() {
  return `
    <div class="conversas-sheet__corpo">
      <div class="conversas-sheet__topo">
        <p class="conversas-sheet__marca">Panteão</p>
        <div class="conversas-sheet__topo-acoes">
          <button class="conversas-sheet__icone-btn" type="button" data-acao="alternar-busca"
                  aria-label="Pesquisar conversas" aria-expanded="${buscaSidebarAberta}">
            ${SVG_LUPA_CONVERSA}
          </button>
          <button class="conversas-sheet__x" type="button" data-conversas-fechar aria-label="Fechar">
            ${SVG_FECHAR}
          </button>
        </div>
      </div>

      ${buscaSidebarAberta ? `
        <label class="conversas-sheet__busca">
          ${SVG_LUPA_CONVERSA}
          <input type="search" data-busca-conversa placeholder="Pesquisar conversas…" aria-label="Pesquisar conversas">
        </label>
      ` : ''}

      <!-- 3 atalhos pra conversa individual + 1 pra montar um conselho
           personalizado (2 ou 3 agentes, à sua escolha) -->
      <div class="conversas-sheet__agentes">
        ${AGENTES.map((a) => `
          <button class="conversas-sheet__agente-card" type="button" data-nova-individual="${a.id}"
                  style="--agente: ${a.cor}">
            <span class="conversas-sheet__agente-glifo" aria-hidden="true">${simboloDoAgente(a.id)}</span>
            <span>${escapar(a.nome)}</span>
          </button>
        `).join('')}
        <button class="conversas-sheet__agente-card conversas-sheet__agente-card--personalizado"
                type="button" data-acao="abrir-personalizado">
          <span class="conversas-sheet__agente-glifo" aria-hidden="true">${SVG_PERSONALIZADO}</span>
          <span>Personalizado</span>
        </button>
      </div>

      ${htmlFiltrosConversa()}

      <p class="conversas-sheet__label">Recentes</p>
      <ul class="conversas-lista" data-regiao="conversas-lista">${htmlListaConversas()}</ul>
    </div>

    <!-- rodapé fixo, fora da área rolável — "Nova conversa" menor, no
         mesmo espírito do "+Chat" do ChatGPT. O "Perfil" aqui embaixo é só
         o lugar reservado: liga com Configuração (e, mais pra frente,
         cadastro de cliente) quando essa peça existir — hoje não faz nada. -->
    <div class="conversas-sheet__rodape">
      <button class="conversas-sheet__nova" type="button" data-acao="nova-conversa">
        ${SVG_NOVA_CONVERSA} <span>Nova conversa</span>
      </button>
    </div>
  `;
}

function htmlSidebar() {
  return `
    <div class="conversas-sheet" data-regiao="conversas-sheet" hidden>
      <div class="conversas-sheet__fundo" data-conversas-fechar aria-hidden="true"></div>
      <div class="conversas-sheet__painel" role="dialog" aria-modal="true" aria-label="Conversas do Panteão">
        ${htmlPainelSidebar()}
      </div>
    </div>
  `;
}

/**
 * A barra lateral, como a gaveta de anexos, NÃO fica dentro da view —
 * mesmo motivo: #app-content cria seu próprio contexto de empilhamento e
 * prenderia qualquer z-index interno atrás da navegação. Anexada direto
 * no <body>, igual à gaveta e ao overlay de auth.js.
 */
let sidebar = null;
let aoClicarSidebar = null;
let aoContextMenuSidebar = null;
let aoTeclarSidebar = null;
let aoSairDoCampoRenomear = null;
let aoBuscarConversa = null;

/** Fecha a sidebar no Escape mesmo com o foco fora dela — o teclado de
 *  dentro do campo de renomear tem seu próprio listener (aoTeclarSidebar,
 *  que interrompe a propagação para não chegar até aqui). */
function aoTeclarSidebarGlobal(evento) {
  if (evento.key === 'Escape') fecharSidebar();
}

/** Redesenha só o painel — reaproveitado ao abrir, ao renomear e ao alternar o retrátil. */
function redesenharPainelSidebar() {
  const painel = sidebar?.querySelector('.conversas-sheet__painel');
  if (painel) painel.innerHTML = htmlPainelSidebar();
}

function abrirSidebar() {
  if (!sidebar) return;
  renomeandoId = null;         // nunca abre já em modo de edição de uma sessão anterior
  buscaSidebarAberta = false;  // nem com a busca expandida de uma vez anterior
  filtroConversas = 'todas';   // "Recentes" sempre reabre do zero, sem filtro herdado
  filtrosConversaAbertos = false;
  redesenharPainelSidebar();   // sempre atual ao abrir
  sidebar.hidden = false;
  void sidebar.offsetWidth;
  sidebar.classList.add('is-aberta');
}

function fecharSidebar() {
  if (!sidebar || sidebar.hidden) return;
  sidebar.classList.remove('is-aberta');
  setTimeout(() => { if (sidebar) sidebar.hidden = true; }, 220);
}

/** Enter/blur salvam o novo título; Escape cancela sem salvar. */
function confirmarRenomeacao(campo) {
  if (renomeandoId === null) return;
  renomearConversa(renomeandoId, campo.value);
  renomeandoId = null;
  redesenharPainelSidebar();
}

function cancelarRenomeacao() {
  renomeandoId = null;
  redesenharPainelSidebar();
}

/**
 * O H1 do cabeçalho principal: "Panteão" no Conselho (modo multi), nome
 * do agente (Miriel/Lux/Nova) numa conversa individual. O rótulo pequeno
 * em cima ("Conselho") não muda nunca — só o título grande.
 */
function tituloCabecalho() {
  const c = conversas.find((x) => x.id === conversaAtivaId);
  if (c?.modo === 'individual') return agentePorId(c.agenteId).nome;
  return 'Panteão';
}

function atualizarTituloCabecalho() {
  const alvo = cabecalho?.querySelector('[data-regiao="titulo-painel"]');
  if (alvo) alvo.textContent = tituloCabecalho();
}

/**
 * Remove a conversa da lista local e, se ela já existir no Supabase,
 * marca excluída lá também (soft-delete — arquivarConversa() no backend).
 * Se era a conversa ativa, troca pra outra (ou cria uma nova vazia, se
 * não sobrar nenhuma).
 */
function excluirConversa(id) {
  const c = conversas.find((x) => x.id === id);
  if (!c) return;

  conversas = conversas.filter((x) => x.id !== id);

  if (conversaAtivaId === id) {
    const proxima = conversas[0] ?? novaConversa();
    conversaAtivaId = proxima.id;
    mensagens = proxima.mensagens;
    redesenharFeed();
    statusOcioso();
    atualizarTituloCabecalho();
  }

  redesenharPainelSidebar();

  if (c.dbId) {
    fetch(`${URL_BACKEND}/api/panteao/conversas/${c.dbId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ excluida: true })
    }).catch((erro) => console.warn('[panteão] não consegui excluir no Supabase:', erro.message));
  }
}

function montarSidebar() {
  const molde = document.createElement('div');
  molde.innerHTML = htmlSidebar().trim();
  sidebar = molde.firstElementChild;
  document.body.appendChild(sidebar);

  aoClicarSidebar = (evento) => {
    if (evento.target.closest('[data-conversas-fechar]')) return fecharSidebar();
    if (evento.target.closest('[data-acao="nova-conversa"]')) return criarConversa();

    const novoIndividual = evento.target.closest('[data-nova-individual]');
    if (novoIndividual) return criarConversaIndividual(novoIndividual.dataset.novaIndividual);

    if (evento.target.closest('[data-acao="abrir-personalizado"]')) return abrirPersonalizadoPopover();

    if (evento.target.closest('[data-acao="alternar-busca"]')) {
      buscaSidebarAberta = !buscaSidebarAberta;
      redesenharPainelSidebar();
      if (buscaSidebarAberta) {
        requestAnimationFrame(() => sidebar?.querySelector('[data-busca-conversa]')?.focus());
      }
      return;
    }

    const filtroBtn = evento.target.closest('[data-filtro-conversa]');
    if (filtroBtn) {
      filtroConversas = filtroBtn.dataset.filtroConversa;
      filtrosConversaAbertos = false;
      redesenharPainelSidebar();
      return;
    }

    if (evento.target.closest('[data-acao="alternar-filtros"]')) {
      filtrosConversaAbertos = !filtrosConversaAbertos;
      redesenharPainelSidebar();
      return;
    }

    // clicar num campo de renomear em edição não deve trocar de conversa
    if (evento.target.closest('[data-renomear-campo]')) return;

    const item = evento.target.closest('[data-conversa-id]');
    if (item) trocarConversa(item.dataset.conversaId);
  };

  // long-press no card (Android/iOS já traduzem isso em 'contextmenu'
  // sozinhos) ou clique direito no desktop — abre o menu ancorado bem
  // onde o dedo/cursor estava, em vez de sempre centralizado
  aoContextMenuSidebar = (evento) => {
    const item = evento.target.closest('[data-conversa-id]');
    if (!item) return;
    evento.preventDefault();
    abrirMenuConversa(item.dataset.conversaId, { x: evento.clientX, y: evento.clientY });
  };

  aoTeclarSidebar = (evento) => {
    const campoRenomear = evento.target.closest('[data-renomear-campo]');
    if (campoRenomear) {
      if (evento.key === 'Enter') { evento.preventDefault(); evento.stopPropagation(); return confirmarRenomeacao(campoRenomear); }
      if (evento.key === 'Escape') { evento.preventDefault(); evento.stopPropagation(); return cancelarRenomeacao(); }
      return;   // qualquer outra tecla digita normalmente — não fecha a sidebar
    }
  };

  // 'blur' não borbulha — 'focusout' é a versão que borbulha, necessária
  // porque o campo de renomear é criado dinamicamente e o listener é
  // delegado no container, não no campo em si
  aoSairDoCampoRenomear = (evento) => {
    const campo = evento.target.closest('[data-renomear-campo]');
    if (campo) confirmarRenomeacao(campo);
  };

  aoBuscarConversa = (evento) => {
    const campoBusca = evento.target.closest('[data-busca-conversa]');
    if (!campoBusca) return;
    const lista = sidebar.querySelector('[data-regiao="conversas-lista"]');
    if (lista) lista.innerHTML = htmlListaConversas(campoBusca.value);
  };

  sidebar.addEventListener('click', aoClicarSidebar);
  sidebar.addEventListener('contextmenu', aoContextMenuSidebar);
  sidebar.addEventListener('keydown', aoTeclarSidebar);
  sidebar.addEventListener('focusout', aoSairDoCampoRenomear);
  sidebar.addEventListener('input', aoBuscarConversa);
  document.addEventListener('keydown', aoTeclarSidebarGlobal);
}

/** Desfaz montarSidebar() — chamado no unmount, para não vazar entre telas. */
function desmontarSidebar() {
  if (sidebar) {
    sidebar.removeEventListener('click', aoClicarSidebar);
    sidebar.removeEventListener('contextmenu', aoContextMenuSidebar);
    sidebar.removeEventListener('keydown', aoTeclarSidebar);
    sidebar.removeEventListener('focusout', aoSairDoCampoRenomear);
    sidebar.removeEventListener('input', aoBuscarConversa);
    sidebar.remove();
  }
  document.removeEventListener('keydown', aoTeclarSidebarGlobal);
  sidebar = null;
  aoClicarSidebar = null;
  aoContextMenuSidebar = null;
  aoTeclarSidebar = null;
  aoSairDoCampoRenomear = null;
  aoBuscarConversa = null;
  renomeandoId = null;
}

/**
 * Arrastar a partir da borda esquerda da tela abre a barra lateral — o
 * mesmo gesto que qualquer app de chat mobile usa para o menu de
 * conversas. Só conta como esse gesto se o toque COMEÇA perto da borda
 * (para não competir com um scroll normal do feed) e se o movimento é
 * majoritariamente horizontal (para não disparar num scroll vertical).
 */
const BORDA_GESTO = 24;      // px da borda esquerda onde o gesto pode começar
const LIMIAR_GESTO = 60;     // px de arrasto horizontal para considerar "abrir"

let inicioToqueX = null;
let inicioToqueY = null;
let aoTocarInicio = null;
let aoTocarMover = null;

function montarGestoSidebar(view) {
  aoTocarInicio = (evento) => {
    if (sidebar && !sidebar.hidden) { inicioToqueX = null; return; }   // já aberta
    const toque = evento.touches[0];
    if (!toque || toque.clientX > BORDA_GESTO) { inicioToqueX = null; return; }
    inicioToqueX = toque.clientX;
    inicioToqueY = toque.clientY;
  };

  aoTocarMover = (evento) => {
    if (inicioToqueX === null) return;
    const toque = evento.touches[0];
    if (!toque) return;
    const dx = toque.clientX - inicioToqueX;
    const dy = Math.abs(toque.clientY - inicioToqueY);
    if (dx > LIMIAR_GESTO && dx > dy * 1.5) {
      abrirSidebar();
      inicioToqueX = null;
    }
  };

  view.addEventListener('touchstart', aoTocarInicio, { passive: true });
  view.addEventListener('touchmove', aoTocarMover, { passive: true });
}

function desmontarGestoSidebar(view) {
  view?.removeEventListener('touchstart', aoTocarInicio);
  view?.removeEventListener('touchmove', aoTocarMover);
  aoTocarInicio = null;
  aoTocarMover = null;
  inicioToqueX = null;
  inicioToqueY = null;
}

/* ==================================================================
   12. MÓDULO
   ================================================================== */
let raiz = null;
let aoClicar = null;
let aoRedimensionarViewport = null;
let aoMedirCabecalho = null;

/**
 * A gaveta de anexos NÃO fica dentro da view. #app-content tem
 * `position:relative; z-index:1`, o que cria um contexto de empilhamento
 * próprio — qualquer coisa fixa renderizada como filha dele fica presa
 * nesse teto, não importa o z-index que ela declare por dentro. Foi por
 * isso que a gaveta aparecia atrás da barra de navegação.
 *
 * O overlay de trava de sessão (auth.js) já resolve isso anexando direto
 * no <body>; a gaveta segue o mesmo caminho.
 */
let gaveta = null;
let aoClicarGaveta = null;
let aoTeclarGaveta = null;

/** Markup da barra de digitação — usado por montarComposer(), não mais
 *  colado direto em render() (ver por quê no comentário de montarComposer). */
function htmlComposer() {
  return `
    <div class="panteao-input">
      ${htmlSugestoesInline()}

      <div data-regiao="anexo-pendente">${htmlChipAnexoPendente()}</div>

      <div class="panteao-input__linha">
        <button class="panteao-btn-icone" type="button" data-acao="anexar" aria-label="Anexar arquivo">
          ${SVG_ANEXAR}
        </button>
        <input type="file" hidden data-arquivo-panteao>

        <textarea class="panteao-textarea" data-campo-texto rows="1"
                  placeholder="Perguntar ao Panteão…" aria-label="Mensagem"></textarea>

        <button class="panteao-btn-icone panteao-btn-mic" type="button" data-acao="gravar"
                aria-label="Ditar mensagem por voz">
          <span class="panteao-btn-mic__svg" aria-hidden="true">${SVG_MIC}</span>
          <span class="onda-audio" aria-hidden="true"><i></i><i></i><i></i></span>
        </button>

        <button class="panteao-btn-enviar" type="button" data-acao="enviar"
                aria-label="Enviar mensagem" disabled>${SVG_ENVIAR}</button>
      </div>
    </div>
  `;
}

let composer = null;
let aoClicarComposer = null;
let aoTeclarComposer = null;
let aoInputComposer = null;
let aoEscolherArquivoComposer = null;
let aoFocarCampoComposer = null;
let aoDesfocarCampoComposer = null;

/**
 * Constrói a barra de digitação e a prende direto no <body> — mesmo
 * motivo estrutural da gaveta/sidebar/menu de conversa: dentro de
 * #app-content, `position: fixed` fica fixo em relação a ELE (se ele tiver
 * qualquer transform/filter, o que cria um novo bloco de contenção), não
 * à tela inteira. Era exatamente o bug relatado — a barra flutuando no
 * meio, porque "fixed" nunca conseguia se ancorar de verdade na viewport.
 * Ancorada aqui fora, funciona igual à gaveta: sempre relativa à tela.
 */
function montarComposer() {
  const molde = document.createElement('div');
  molde.innerHTML = htmlComposer().trim();
  composer = molde.firstElementChild;
  document.body.appendChild(composer);

  const campo = composer.querySelector('[data-campo-texto]');
  const botaoEnviar = composer.querySelector('[data-acao="enviar"]');
  const atualizarBotaoEnviar = () => {
    botaoEnviar.disabled = !campo.value.trim() && !anexoPendente;
  };

  // esconde a navbar do app enquanto o teclado está aberto — mesmo padrão
  // de qualquer app de chat (WhatsApp, Telegram): a barra de digitação é
  // a única coisa que precisa subir, a navbar só atrapalharia competindo
  // pelo mesmo espaço acima do teclado
  aoFocarCampoComposer = () => {
    window.scrollTo(0, 0);   // trava no topo ANTES da página virar fixed
    document.body.classList.add('panteao-teclado-aberto');
    // ancora o feed na última mensagem (ou fica parado, se a conversa
    // está vazia) — o fundo não "anda", o conteúdo é que se ajusta pra
    // ficar colado acima do teclado, igual WhatsApp/Telegram fazem
    const feed = raiz?.querySelector('[data-regiao="feed"]');
    if (feed) requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
  };
  aoDesfocarCampoComposer = () => document.body.classList.remove('panteao-teclado-aberto');
  campo.addEventListener('focus', aoFocarCampoComposer);
  campo.addEventListener('blur', aoDesfocarCampoComposer);

  aoClicarComposer = (evento) => {
    if (evento.target.closest('[data-acao="enviar"]')) return enviarMensagem();

    if (evento.target.closest('[data-acao="gravar"]')) {
      return ouvindo ? pararTranscricao(composer) : iniciarTranscricao(composer);
    }

    if (evento.target.closest('[data-acao="anexar"]')) return abrirGavetaAnexos();

    if (evento.target.closest('[data-remover-anexo]')) {
      anexoPendente = null;
      atualizarBarraDeAnexo(composer);
      atualizarBotaoEnviar();
      return;
    }

    const sugestao = evento.target.closest('[data-sugestao]');
    if (sugestao) {
      campo.value = sugestao.dataset.sugestao;
      atualizarBotaoEnviar();
      return enviarMensagem();   // enviarMensagem() já apaga as pílulas
    }
  };

  aoTeclarComposer = (evento) => {
    if (evento.target !== campo) return;
    if (evento.key === 'Enter' && !evento.shiftKey) {
      evento.preventDefault();
      if (!botaoEnviar.disabled) enviarMensagem();
    }
  };

  aoInputComposer = (evento) => {
    if (evento.target === campo) {
      ajustarAlturaTextarea(campo);
      atualizarBotaoEnviar();
    }
  };

  aoEscolherArquivoComposer = (evento) => {
    const input = evento.target.closest('[data-arquivo-panteao]');
    if (!input?.files?.[0]) return;
    const arquivo = input.files[0];
    anexoPendente = { nome: arquivo.name, tipo: 'arquivo', tamanho: arquivo.size };
    atualizarBarraDeAnexo(composer);
    atualizarBotaoEnviar();
    input.value = '';
  };

  composer.addEventListener('click', aoClicarComposer);
  composer.addEventListener('keydown', aoTeclarComposer);
  composer.addEventListener('input', aoInputComposer);
  composer.addEventListener('change', aoEscolherArquivoComposer);
}

/** Desfaz montarComposer() — chamado no unmount, para não vazar entre telas. */
function desmontarComposer() {
  if (composer) {
    composer.removeEventListener('click', aoClicarComposer);
    composer.removeEventListener('keydown', aoTeclarComposer);
    composer.removeEventListener('input', aoInputComposer);
    composer.removeEventListener('change', aoEscolherArquivoComposer);
    composer.querySelector('[data-campo-texto]')?.removeEventListener('focus', aoFocarCampoComposer);
    composer.querySelector('[data-campo-texto]')?.removeEventListener('blur', aoDesfocarCampoComposer);
    composer.remove();
  }
  document.body.classList.remove('panteao-teclado-aberto');
  composer = null;
  aoClicarComposer = null;
  aoTeclarComposer = null;
  aoInputComposer = null;
  aoEscolherArquivoComposer = null;
  aoFocarCampoComposer = null;
  aoDesfocarCampoComposer = null;
}

/** Constrói o nó da gaveta e o prende ao body — chamado uma vez no mount. */
function montarGaveta() {
  const molde = document.createElement('div');
  molde.innerHTML = htmlGavetaAnexos().trim();
  gaveta = molde.firstElementChild;
  document.body.appendChild(gaveta);

  aoClicarGaveta = (evento) => {
    if (evento.target.closest('[data-anexo-fechar]')) return fecharGavetaAnexos();

    const acao = evento.target.closest('[data-anexo-acao]');
    if (acao) {
      const alvo = ACOES_ANEXO.find((a) => a.id === acao.dataset.anexoAcao);

      if (alvo?.tipo === 'drive') {
        console.info('[panteão] "Adicionar do Drive" ainda não conectado.');
        fecharGavetaAnexos();
        return;
      }

      const input = composer?.querySelector('[data-arquivo-panteao]');
      if (alvo && input) {
        input.accept = alvo.accept ?? '';
        fecharGavetaAnexos();
        input.click();
      }
      return;
    }
  };

  aoTeclarGaveta = (evento) => {
    if (evento.key === 'Escape') fecharGavetaAnexos();
  };

  gaveta.addEventListener('click', aoClicarGaveta);
  document.addEventListener('keydown', aoTeclarGaveta);
}

/** Desfaz montarGaveta() — chamado no unmount, para não vazar entre telas. */
function desmontarGaveta() {
  if (gaveta) {
    gaveta.removeEventListener('click', aoClicarGaveta);
    gaveta.remove();
  }
  document.removeEventListener('keydown', aoTeclarGaveta);
  gaveta = null;
  aoClicarGaveta = null;
  aoTeclarGaveta = null;
}

/**
 * Mantém a barra de entrada colada acima do teclado do celular, aberto ou
 * fechado. A Visual Viewport API é o jeito real de saber a altura do
 * teclado — não tem como simular isso com CSS puro, porque o navegador não
 * expõe o teclado como algo que `env()`/media query enxergam.
 *
 * `--teclado-altura` é lida pelo panteao.css na regra de `bottom` do dock.
 * Sem essa variável (desktop, ou navegador sem suporte), o CSS cai no
 * valor padrão de sempre — nada quebra.
 */
/**
 * Duas coisas nesta função: (1) mede o teclado (guardado em
 * --teclado-altura, hoje não consumido pelo CSS — ver nota no
 * panteao.css) e (2) desfaz a rolagem automática que o navegador faz
 * sozinho ao focar um campo de texto — ele tenta "revelar" o campo mesmo
 * quando ele já está visível por ser fixed, e isso empurra o cabeçalho
 * pra fora da tela por engano. Forçar a rolagem de volta pro topo toda
 * vez que a visual viewport mexe desfaz esse comportamento.
 */
/**
 * O cabeçalho do Panteão agora é fixed e vive fora da view (ver
 * montarCabecalho) — o feed que vem logo depois dele na tela precisa de
 * um respiro no topo do tamanho exato da altura dele, ou o conteúdo nasce
 * escondido por baixo. Medido de verdade (ResizeObserver), não chutado —
 * a altura muda um pouco dependendo de quebra de linha do título/ícones
 * em telas estreitas. `view` aqui é só onde a variável CSS é escrita
 * (a view continua sendo o pai do feed).
 */
function medirCabecalhoPanteao(view) {
  if (!cabecalho) return null;

  const atualizar = () => {
    view.style.setProperty('--panteao-head-h', `${cabecalho.offsetHeight}px`);
  };

  const observador = new ResizeObserver(atualizar);
  observador.observe(cabecalho);
  atualizar();

  return () => observador.disconnect();
}

function acompanharTeclado(view) {
  if (!window.visualViewport) return null;

  // >>> PAINEL DE DIAGNÓSTICO TEMPORÁRIO — desta vez com bem mais dado:
  // além dos números do teclado, mostra onde a barra de digitação REALMENTE
  // está na tela, e se a trava de rolagem (panteao-teclado-aberto) está
  // ativa de verdade. Remover depois de achar a causa. <<<
  let debug = document.getElementById('debug-teclado');
  if (!debug) {
    debug = document.createElement('div');
    debug.id = 'debug-teclado';
    debug.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 999999;
      padding: 6px 10px; background: #B91C1C; color: #fff;
      font: 10px/1.35 monospace; white-space: pre-wrap;
    `;
    document.body.appendChild(debug);
  }

  const atualizar = () => {
    const vv = window.visualViewport;
    const oculto = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    view.style.setProperty('--teclado-altura', `${oculto}px`);

    if (window.scrollY !== 0) window.scrollTo(0, 0);
    if (document.scrollingElement?.scrollTop) document.scrollingElement.scrollTop = 0;

    const barra = composer?.getBoundingClientRect();
    const cabecalhoRect = cabecalho?.getBoundingClientRect();
    const travado = document.body.classList.contains('panteao-teclado-aberto');
    const posBody = getComputedStyle(document.body).position;

    debug.textContent =
      `innerH=${window.innerHeight} vvH=${Math.round(vv.height)} vvTop=${Math.round(vv.offsetTop)} teclado=${Math.round(oculto)}\n`
      + `travado=${travado} body.position=${posBody} scrollY=${window.scrollY}\n`
      + `barra.top=${barra ? Math.round(barra.top) : '?'} barra.bottom=${barra ? Math.round(barra.bottom) : '?'}\n`
      + `cabecalho.bottom=${cabecalhoRect ? Math.round(cabecalhoRect.bottom) : '?'} janela=${window.innerHeight}`;
  };

  window.visualViewport.addEventListener('resize', atualizar);
  window.visualViewport.addEventListener('scroll', atualizar);
  atualizar();

  return () => {
    window.visualViewport.removeEventListener('resize', atualizar);
    window.visualViewport.removeEventListener('scroll', atualizar);
    debug?.remove();
  };
}

function ajustarAlturaTextarea(campo) {
  campo.style.height = 'auto';
  campo.style.height = `${Math.min(campo.scrollHeight, 132)}px`;
}

async function enviarMensagem() {
  const campo = composer.querySelector('[data-campo-texto]');
  const texto = campo.value.trim();
  if (!texto && !anexoPendente) return;

  if (!sessaoLiberada()) {
    console.warn('[panteão] sessão bloqueada — envio suspenso.');
    return;
  }

  mensagens.push({ id: proximoId++, autor: 'usuario', texto, anexo: anexoPendente });
  talvezTitular(conversaAtivaId, texto);

  campo.value = '';
  ajustarAlturaTextarea(campo);
  anexoPendente = null;
  atualizarBarraDeAnexo(composer);
  redesenharFeed();
  statusOcioso();

  const botaoEnviar = composer.querySelector('[data-acao="enviar"]');
  if (botaoEnviar) botaoEnviar.disabled = true;
  // agora sim: mensagens.length já é > 0 aqui — a chamada abaixo APAGA o
  // bloco de vez, em vez de reexibi-lo (era o bug: reaparecia após enviar)
  atualizarSugestoes(composer);

  const entrada = texto || 'anexo enviado';
  const conversaAtiva = conversas.find((c) => c.id === conversaAtivaId);

  if (conversaAtiva?.modo === 'individual') {
    await simularIndividual(conversaAtiva.agenteId, entrada);
  } else {
    const participantes = conversaAtiva?.participantes ?? null;
    let liderId = escolherAgente(entrada);
    if (participantes && !participantes.includes(liderId)) liderId = participantes[0];
    await simularConselho(liderId, entrada, participantes);
  }
}

/** Markup do cabeçalho do Panteão — usado por montarCabecalho(), não mais
 *  colado direto em render() (mesmo motivo do composer: precisa viver
 *  fora de #app-content pra "position: fixed" funcionar de verdade). */
function htmlCabecalhoPanteao() {
  return `
    <header class="view__head panteao-head">
      <div class="panteao-head__titulo">
        <button class="panteao-btn-icone panteao-btn-menu" type="button"
                data-acao="abrir-conversas" aria-label="Conversas">
          ${SVG_MENU}
        </button>
        <div>
          <span class="view__eyebrow">Conselho</span>
          <h1 class="view__title" data-regiao="titulo-painel">${tituloCabecalho()}</h1>
        </div>
      </div>

      <div class="panteao-head__direita">
        ${htmlHud()}

        <button class="token-contador" type="button" data-acao="abrir-tokens"
                title="Tokens usados nesta sessão, somando entrada e saída da Gemini">
          <span class="token-contador__rotulo">Tokens</span>
          <span class="token-contador__valor" data-regiao="token-contador">${tokensUsados.total ? tokensUsados.total.toLocaleString('pt-BR') : '--'}</span>
        </button>
      </div>
    </header>
  `;
}

let cabecalho = null;
let aoClicarCabecalho = null;

/**
 * Constrói o cabeçalho do Panteão e prende ele direto no <body> — mesmo
 * motivo estrutural de tudo mais nesta tela (composer, gaveta, sidebar,
 * menu de conversa): dentro de #app-content, "position: fixed" não é fixo
 * em relação à TELA, é fixo em relação a #app-content (ou a algum
 * ancestral com transform/filter) — daí o cabeçalho aparecendo no meio da
 * tela em vez de grudado no topo, exatamente o mesmo bug que a barra de
 * digitação já teve antes de ganhar este mesmo tratamento.
 */
function montarCabecalho() {
  const molde = document.createElement('div');
  molde.innerHTML = htmlCabecalhoPanteao().trim();
  cabecalho = molde.firstElementChild;
  document.body.appendChild(cabecalho);

  aoClicarCabecalho = (evento) => {
    if (evento.target.closest('[data-acao="abrir-conversas"]')) return abrirSidebar();
    if (evento.target.closest('[data-acao="abrir-tokens"]')) return abrirTokensPopover();
  };

  cabecalho.addEventListener('click', aoClicarCabecalho);
}

function desmontarCabecalho() {
  if (cabecalho) {
    cabecalho.removeEventListener('click', aoClicarCabecalho);
    cabecalho.remove();
  }
  cabecalho = null;
  aoClicarCabecalho = null;
}

const panteao = {
  id: 'panteao',
  title: 'Panteão',

  render() {
    const view = document.createElement('section');
    view.dataset.module = this.id;

    view.innerHTML = `
      <div class="panteao-feed" data-regiao="feed" aria-live="polite">${htmlFeed()}</div>
    `;

    return view;
  },

  mount(view) {
    raiz = view;
    statusOcioso();

    aoClicar = (evento) => {
      const toggleTimeline = evento.target.closest('[data-timeline-toggle]');
      if (toggleTimeline) {
        const corpo = view.querySelector(`[data-timeline-corpo="${toggleTimeline.dataset.timelineToggle}"]`);
        const aberta = toggleTimeline.getAttribute('aria-expanded') === 'true';
        toggleTimeline.setAttribute('aria-expanded', String(!aberta));
        toggleTimeline.querySelector('.timeline__seta').classList.toggle('timeline__seta--aberta', !aberta);
        if (corpo) corpo.hidden = aberta;
        return;
      }

      const copiar = evento.target.closest('[data-copiar-codigo]');
      if (copiar) {
        const codigo = copiar.parentElement.querySelector('code')?.textContent ?? '';
        navigator.clipboard?.writeText(codigo).then(() => {
          copiar.textContent = 'Copiado!';
          setTimeout(() => { copiar.textContent = 'Copiar'; }, 1500);
        });
        return;
      }

      const chip = evento.target.closest('[data-acao-chip]');
      if (chip) {
        // Sem backend ainda: registra a intenção. Ligar em routes/ quando existir.
        console.info('[panteão] ação rápida sem destino:', chip.dataset.acaoChip);
        chip.disabled = true;
        chip.textContent = 'Feito';
        return;
      }
    };

    view.addEventListener('click', aoClicar);

    montarCabecalho();
    aoMedirCabecalho = medirCabecalhoPanteao(view);
    montarComposer();
    aoRedimensionarViewport = acompanharTeclado(composer);
    montarGaveta();
    montarSidebar();
    montarGestoSidebar(view);
    montarMenuConversa();
  },

  unmount() {
    if (ouvindo) pararTranscricao(composer);
    desmontarCabecalho();
    desmontarComposer();
    desmontarGaveta();
    desmontarSidebar();
    desmontarGestoSidebar(raiz);
    desmontarMenuConversa();
    aoRedimensionarViewport?.();
    aoRedimensionarViewport = null;
    aoMedirCabecalho?.();
    aoMedirCabecalho = null;
    if (raiz) {
      raiz.removeEventListener('click', aoClicar);
    }
    aoClicar = null;
    raiz = null;
  },

  // API pública para conectar um backend real — ver o bloco de comentário
  // no topo do arquivo.
  iniciarFluxo,
  adicionarPassoTimeline,
  finalizarResposta
};

export default panteao;
