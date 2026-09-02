/**
 * SAN & CO. — módulo Rotina (id interno "agenda", rótulo visível "Rotina")
 *
 * SEGUNDA VERSÃO — página única, sem abas Dia/Mês/Ano. Os 4 cards vivem
 * juntos numa dashboard: Tarefas diárias, Treino, Saúde, Agenda mensal —
 * mais o Segundo Cérebro abaixo de tudo. Decisão tomada com o usuário:
 * "página única com os 4 cards" venceu "manter abas".
 *
 * O que cada card faz, e o que ainda depende de integração externa:
 *   - Tarefas diárias: checklist do dia — igual à v1, só mudou de casa.
 *   - Treino: catálogo de divisões (Push A, Pull A...) construído pelo
 *     próprio usuário — nada de exercício de exemplo inventado. Cada
 *     exercício abre uma TELA PRÓPRIA (telaTreino) com registro de séries
 *     (peso/repetição, como no Garmin) e o histórico de carga entre dias.
 *   - Saúde: fusão de Sono + Nutrição da v1. Tem uma nota reservada para
 *     diagnóstico 24h por smartwatch — vazia e honesta até essa integração
 *     existir, não um valor fake.
 *   - Agenda mensal: a grade do mês, no espírito do Google Agenda. Tocar
 *     no rótulo do mês abre o seletor de mês/ano (substitui a antiga aba
 *     Ano). O "+" no rodapé cria um compromisso manual do dia — usa o
 *     mesmo array `compromissos` que já esperava a sincronização com o
 *     Google Calendar, só que agora também aceita entrada manual enquanto
 *     ela não existe (mesmo espírito do .OFX no Financeiro: caminho manual
 *     até a integração automática chegar).
 *   - Segundo Cérebro: busca + filtro por tag priorizados (decisão do
 *     usuário), com um título opcional por nota — não virou blocos/Notion
 *     de verdade, mas já é mais fácil de achar o que já foi escrito.
 *
 * Tudo aqui continua em memória — Rotina ainda não foi migrada para o
 * Supabase (só Financeiro foi, nesta fase). Nada sobrevive a um F5 ainda.
 */

import { sessaoLiberada } from '../state.js';

/* ==================================================================
   1. DATAS — helpers puros, sem depender de fuso/servidor
   ================================================================== */
const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
               'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

function doisDigitos(n) { return String(n).padStart(2, '0'); }

/** Date -> 'AAAA-MM-DD', sempre no fuso local (nunca toISOString, que vira UTC). */
function chaveDia(data) {
  return `${data.getFullYear()}-${doisDigitos(data.getMonth() + 1)}-${doisDigitos(data.getDate())}`;
}

function hoje() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 'AAAA-MM-DD' -> Date, à meia-noite local. */
function dataDaChave(chave) {
  const [ano, mes, dia] = chave.split('-').map(Number);
  return new Date(ano, mes - 1, dia);
}

function somarDias(data, n) {
  const d = new Date(data);
  d.setDate(d.getDate() + n);
  return d;
}

/** 'Hoje', 'Ontem', 'Amanhã' ou '21 de agosto'. */
function rotuloDia(chave) {
  const alvo = dataDaChave(chave);
  const diffDias = Math.round((alvo - hoje()) / 86_400_000);
  if (diffDias === 0) return 'Hoje';
  if (diffDias === -1) return 'Ontem';
  if (diffDias === 1) return 'Amanhã';
  return `${alvo.getDate()} de ${MESES[alvo.getMonth()].toLowerCase()}`;
}

/** Todas as células de um mês na grade 7 colunas — inclui dias do mês
 *  anterior/seguinte para completar a primeira e a última semana. */
function celulasDoMes(ano, mes) {
  const primeiro = new Date(ano, mes, 1);
  const ultimo = new Date(ano, mes + 1, 0);
  const inicioGrade = somarDias(primeiro, -primeiro.getDay());
  const fimGrade = somarDias(ultimo, 6 - ultimo.getDay());

  const celulas = [];
  for (let d = inicioGrade; d <= fimGrade; d = somarDias(d, 1)) {
    celulas.push({ data: new Date(d), foraDoMes: d.getMonth() !== mes });
  }
  return celulas;
}

/* ==================================================================
   2. ESTADO EM MEMÓRIA — protocolo do dia
   Indexado por dia — "resetar à meia-noite" não precisa de temporizador,
   é só o dia virar e a chave mudar; o dia de ontem continua existindo no
   objeto, só não é mais o que a tela mostra por padrão.
   ================================================================== */

const TAREFAS_FIXAS = ['Fluxo de caixa matinal', 'Briefing do dia', 'Leitura'];
const REFEICOES = ['Café da manhã', 'Almoço', 'Jantar'];
const META_AGUA_L = 3;

/** @returns {object} um registro de protocolo vazio para um dia novo */
function protocoloVazio() {
  return {
    tarefasFixas: Object.fromEntries(TAREFAS_FIXAS.map((t) => [t, false])),
    treino: {
      divisaoId: null,      // qual divisão do catálogo foi treinada hoje
      registros: {}         // { [exercicioId]: { series: [{peso, repeticoes}] } }
    },
    sono: { horas: null, energia: null },
    nutricao: { aguaL: 0, refeicoes: Object.fromEntries(REFEICOES.map((r) => [r, false])), suplementacao: '' },
    compromissos: []   // timeline do dia — Google Calendar quando existir, manual até lá
  };
}

let protocoloPorDia = {};   // { 'AAAA-MM-DD': protocoloVazio() }

function protocoloDe(chave) {
  if (!protocoloPorDia[chave]) protocoloPorDia[chave] = protocoloVazio();
  return protocoloPorDia[chave];
}

/* ==================================================================
   2.1 TREINO — catálogo de divisões e exercícios
   Nasce vazio de propósito: nenhum exercício de exemplo é inventado. O
   próprio usuário monta a divisão (nome + grupos musculares) e depois os
   exercícios dentro dela (nome, músculo, meta de séries/repetições).
   ================================================================== */

let divisoesTreino = [];       // { id, nome, musculos: string[], exercicios: [{id,nome,musculo,seriesMeta,repeticoesMeta}] }
let proximaDivisaoId = 1;
let proximoExercicioId = 1;

function divisaoPorId(id) {
  return divisoesTreino.find((d) => d.id === id) ?? null;
}

function exercicioPorId(id) {
  for (const d of divisoesTreino) {
    const ex = d.exercicios.find((e) => e.id === id);
    if (ex) return { divisao: d, exercicio: ex };
  }
  return null;
}

/**
 * Histórico de carga de um exercício, olhando todos os dias registrados.
 * Cada entrada é o maior peso levantado naquele dia — progressão de carga
 * é sobre o pico, não a média. Vem ordenado do mais recente pro mais
 * antigo. Nunca inclui o dia de hoje incompleto como "histórico" — hoje é
 * o registro ativo, exibido à parte na tela do exercício.
 */
function historicoDoExercicio(exercicioId, excluirChave) {
  return Object.entries(protocoloPorDia)
    .filter(([chave]) => chave !== excluirChave)
    .map(([chave, p]) => {
      const registro = p.treino.registros[exercicioId];
      if (!registro?.series.length) return null;
      const maiorPeso = Math.max(...registro.series.map((s) => s.peso ?? 0));
      return { chave, maiorPeso, series: registro.series.length };
    })
    .filter(Boolean)
    .sort((a, b) => b.chave.localeCompare(a.chave));
}

/* ==================================================================
   2.2 SEGUNDO CÉREBRO
   ================================================================== */
let notas = [];
let proximaNotaId = 1;
const TAGS_DISPONIVEIS = ['#Tech', '#Negócios', '#Sistemas', '#Biologia'];

let buscaNotas = '';
let tagFiltroNotas = null;

function notasFiltradas() {
  return notas.filter((n) => {
    if (tagFiltroNotas && !n.tags.includes(tagFiltroNotas)) return false;
    if (!buscaNotas) return true;
    const alvo = buscaNotas.toLowerCase();
    return (n.titulo ?? '').toLowerCase().includes(alvo)
        || n.texto.toLowerCase().includes(alvo)
        || n.tags.some((t) => t.toLowerCase().includes(alvo));
  });
}

/* ==================================================================
   3. NAVEGAÇÃO — dia (cards diários) e mês/ano (card de Agenda)
   Duas navegações independentes: `diaAtivo` governa Tarefas/Treino/
   Saúde/Timeline; `mesAtivo` governa só o card de Agenda mensal.
   ================================================================== */
let diaAtivo = chaveDia(hoje());
let mesAtivo = { ano: hoje().getFullYear(), mes: hoje().getMonth() };

/** Seletor de mês/ano do card de Agenda — substitui a antiga aba Ano. */
let seletorMesAnoAberto = false;   // false | 'mes' | 'ano'
let anoDoSeletor = hoje().getFullYear();

/** Tela de exercício aberta (drilldown) — null = painel normal. */
let telaTreino = null;   // null | { exercicioId }

/** Gavetas de criação — estado explícito, sempre reconstruídas por desenhar()
 *  em vez de inseridas soltas no DOM (assim nenhuma ação em outro canto da
 *  tela derruba a gaveta aberta sem querer). */
let divisaoSheetAberta = false;
let exercicioSheetDivisaoId = null;   // não-nulo = gaveta de exercício aberta, pra essa divisão

/* ==================================================================
   4. FORMATAÇÃO E ESCAPE
   ================================================================== */
function escapar(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function pesoFmt(kg) {
  return Number.isFinite(kg) ? `${kg}kg` : '--';
}

/* ==================================================================
   5. ÍCONES DESENHADOS — mesma linha do resto do app, sem emoji
   ================================================================== */
const SVG_SETA_ESQ = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 6 9 12 15 18"/></svg>`;
const SVG_SETA_DIR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>`;
const SVG_FORJA = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M9.5 1.5 3 8l2 2 6.5-6.5Z"/><path d="M11.5 3.5 13 5"/><path d="M3 13.5 5.5 11 5 10.5 2.5 13Z"/>
</svg>`;
const SVG_BUSCA = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;

/* ==================================================================
   6. CARD — TAREFAS DIÁRIAS
   ================================================================== */

function htmlTarefasFixas(protocolo) {
  const feitas = Object.values(protocolo.tarefasFixas).filter(Boolean).length;
  const total = TAREFAS_FIXAS.length;
  return `
    <article class="card-exec">
      <header class="card-exec__topo"><span class="card-exec__label">Tarefas diárias</span></header>
      <p class="card-exec__valor">${feitas}/${total}</p>
      <span class="card-exec__faixa card-exec__faixa--${feitas === total && total > 0 ? 'positivo' : 'neutro'}" aria-hidden="true"></span>
      <ul class="rotina-checklist">
        ${TAREFAS_FIXAS.map((t) => `
          <li>
            <button class="rotina-checklist__item ${protocolo.tarefasFixas[t] ? 'is-feita' : ''}"
                    type="button" data-tarefa-fixa="${escapar(t)}"
                    aria-pressed="${protocolo.tarefasFixas[t]}">
              <span class="rotina-checklist__caixa" aria-hidden="true"></span>
              ${escapar(t)}
            </button>
          </li>
        `).join('')}
      </ul>
    </article>
  `;
}

/* ==================================================================
   7. CARD — TREINO (painel) + TELA DE EXERCÍCIO (drilldown)
   ================================================================== */

/** Painel normal do card de Treino: divisão de hoje + lista de exercícios. */
function htmlTreinoPainel(protocolo) {
  const divisao = divisaoPorId(protocolo.treino.divisaoId);

  if (!divisoesTreino.length) {
    return `
      <article class="card-exec">
        <header class="card-exec__topo"><span class="card-exec__label">Treino</span></header>
        <div class="slot" style="margin-top:12px;">
          <span class="slot__mark" aria-hidden="true"></span>
          <p class="slot__text">Nenhuma divisão criada ainda. Monte a primeira (ex.: Push A) para começar a registrar séries.</p>
        </div>
        <button class="btn btn--gold" type="button" data-acao="nova-divisao" style="width:100%; margin-top:12px;">
          + Nova divisão
        </button>
      </article>
    `;
  }

  if (!divisao) {
    return `
      <article class="card-exec">
        <header class="card-exec__topo"><span class="card-exec__label">Treino</span></header>
        <p class="rotina-campo-rotulado__span" style="margin-top:12px;">Qual divisão você treinou hoje?</p>
        <div class="rotina-chip-lista">
          ${divisoesTreino.map((d) => `
            <button class="rotina-chip" type="button" data-escolher-divisao="${d.id}">${escapar(d.nome)}</button>
          `).join('')}
        </div>
        <button class="btn btn--gold" type="button" data-acao="nova-divisao" style="width:100%; margin-top:12px;">
          + Nova divisão
        </button>
      </article>
    `;
  }

  const registros = protocolo.treino.registros;
  const total = divisao.exercicios.length;
  const concluidos = divisao.exercicios.filter((e) => (registros[e.id]?.series.length ?? 0) > 0).length;

  // agrupa por músculo, na ordem em que os músculos foram declarados na divisão
  const porMusculo = divisao.musculos.map((musculo) => ({
    musculo,
    exercicios: divisao.exercicios.filter((e) => e.musculo === musculo)
  })).filter((g) => g.exercicios.length);

  const semGrupo = divisao.exercicios.filter((e) => !divisao.musculos.includes(e.musculo));

  const linhaExercicio = (ex) => {
    const registro = registros[ex.id];
    const seriesFeitas = registro?.series.length ?? 0;
    const feito = seriesFeitas > 0;
    return `
      <li class="rotina-exercicio-linha ${feito ? 'is-feito' : ''}" data-clickable="true" role="button" tabindex="0"
          data-abrir-exercicio="${ex.id}"
          aria-label="${escapar(ex.nome)}, meta ${ex.seriesMeta}x${ex.repeticoesMeta}, ${seriesFeitas} de ${ex.seriesMeta} séries feitas. Abrir registro.">
        <span class="rotina-exercicio-linha__caixa" aria-hidden="true"></span>
        <span class="rotina-exercicio-linha__nome">${escapar(ex.nome)}</span>
        <span class="rotina-exercicio-linha__meta">${seriesFeitas}/${ex.seriesMeta} × ${ex.repeticoesMeta}</span>
      </li>
    `;
  };

  return `
    <article class="card-exec">
      <header class="card-exec__topo">
        <span class="card-exec__label">Treino</span>
        <span class="card-exec__tag">${escapar(divisao.nome)}</span>
      </header>
      <p class="card-exec__valor">${concluidos}/${total}</p>
      <span class="card-exec__faixa card-exec__faixa--${concluidos === total && total > 0 ? 'positivo' : 'neutro'}" aria-hidden="true"></span>
      <p class="card-exec__sub">Exercícios com pelo menos 1 série registrada hoje</p>

      ${porMusculo.map((g) => `
        <p class="rotina-campo-rotulado__span" style="margin-top:14px;">${escapar(g.musculo)}</p>
        <ul class="rotina-exercicio-lista">${g.exercicios.map(linhaExercicio).join('')}</ul>
      `).join('')}
      ${semGrupo.length ? `
        <ul class="rotina-exercicio-lista">${semGrupo.map(linhaExercicio).join('')}</ul>
      ` : ''}

      <div class="rotina-treino-rodape">
        <button class="rotina-link-discreto" type="button" data-acao="trocar-divisao">Trocar divisão</button>
        <button class="rotina-link-discreto" type="button" data-acao="abrir-novo-exercicio" data-divisao="${divisao.id}">+ Exercício</button>
        <button class="rotina-link-discreto" type="button" data-acao="nova-divisao">+ Nova divisão</button>
      </div>
    </article>
  `;
}

/** Tela dedicada de um exercício — registro de séries + histórico de carga. */
function htmlExercicioDetalhe(exercicioId) {
  const achado = exercicioPorId(exercicioId);
  if (!achado) {
    return `
      <div class="slot">
        <span class="slot__mark" aria-hidden="true"></span>
        <p class="slot__text">Exercício não encontrado — pode ter sido removido da divisão.</p>
      </div>
      <button class="rotina-link-discreto" type="button" data-acao="fechar-exercicio" style="margin-top:12px;">&larr; Voltar ao treino</button>
    `;
  }

  const { exercicio } = achado;
  const protocolo = protocoloDe(diaAtivo);
  const registro = protocolo.treino.registros[exercicio.id] ?? { series: [] };
  const historico = historicoDoExercicio(exercicio.id, diaAtivo);

  return `
    <button class="rotina-link-discreto" type="button" data-acao="fechar-exercicio">&larr; Voltar ao treino</button>

    <header class="view__head" style="margin-top:10px; padding:0;">
      <span class="view__eyebrow">${escapar(achado.divisao.nome)} · ${escapar(exercicio.musculo)}</span>
      <h1 class="view__title" style="font-size:20px;">${escapar(exercicio.nome)}</h1>
    </header>
    <p class="card-exec__sub">Meta: ${exercicio.seriesMeta} séries × ${exercicio.repeticoesMeta} repetições</p>

    <section class="section">
      <p class="section__label">Registrado hoje</p>
      ${registro.series.length ? `
        <table class="rotina-tabela-series">
          <thead><tr><th>Série</th><th>Peso</th><th>Repetições</th></tr></thead>
          <tbody>
            ${registro.series.map((s, i) => `
              <tr><td>${i + 1}</td><td>${pesoFmt(s.peso)}</td><td>${s.repeticoes ?? '--'}</td></tr>
            `).join('')}
          </tbody>
        </table>
      ` : `<p class="rotina-notas__vazio">Nenhuma série registrada ainda hoje.</p>`}

      <div class="rotina-registrar-serie">
        <label class="rotina-campo-rotulado" style="flex:1;">
          <span>Peso (kg)</span>
          <input class="rotina-campo" type="number" min="0" step="0.5" data-serie-peso placeholder="--">
        </label>
        <label class="rotina-campo-rotulado" style="flex:1;">
          <span>Repetições</span>
          <input class="rotina-campo" type="number" min="0" step="1" data-serie-repeticoes placeholder="--">
        </label>
        <button class="btn btn--gold" type="button" data-acao="registrar-serie" data-exercicio="${exercicio.id}">
          + Registrar série
        </button>
      </div>
    </section>

    <section class="section">
      <p class="section__label">Progressão de carga</p>
      ${historico.length ? `
        <ul class="rotina-historico-carga">
          ${historico.map((h) => `
            <li>
              <span>${rotuloDia(h.chave)}</span>
              <span>${pesoFmt(h.maiorPeso)} · ${h.series} ${h.series === 1 ? 'série' : 'séries'}</span>
            </li>
          `).join('')}
        </ul>
      ` : `<p class="rotina-notas__vazio">Sem histórico suficiente ainda — volte depois de mais um dia de treino.</p>`}
    </section>
  `;
}

/** Formulário inline de criação de divisão nova. */
function htmlFormNovaDivisao() {
  return `
    <div class="anexo-sheet" data-regiao="divisao-sheet">
      <div class="anexo-sheet__fundo" data-fechar-form-divisao aria-hidden="true"></div>
      <div class="anexo-sheet__painel" role="dialog" aria-modal="true" aria-label="Nova divisão de treino"
           style="max-width:360px; border-radius:18px;">
        <p class="modelo-popover__titulo" style="color:var(--gold)">Nova divisão</p>
        <label class="rotina-campo-rotulado" style="margin-top:12px;">
          <span>Nome</span>
          <input class="rotina-campo" type="text" data-divisao-nome placeholder="Ex.: Push A">
        </label>
        <label class="rotina-campo-rotulado">
          <span>Grupos musculares (separados por vírgula)</span>
          <input class="rotina-campo" type="text" data-divisao-musculos placeholder="Ex.: Peito, Ombro, Tríceps">
        </label>
        <button class="btn btn--gold" type="button" data-acao="confirmar-divisao" style="width:100%; margin-top:14px;">
          Criar divisão
        </button>
      </div>
    </div>
  `;
}

/** Formulário inline de novo exercício, anexado à divisão de hoje. */
function htmlFormNovoExercicio(divisaoId) {
  const divisao = divisaoPorId(divisaoId);
  if (!divisao) return '';
  return `
    <div class="anexo-sheet" data-regiao="exercicio-sheet">
      <div class="anexo-sheet__fundo" data-fechar-form-exercicio aria-hidden="true"></div>
      <div class="anexo-sheet__painel" role="dialog" aria-modal="true" aria-label="Novo exercício"
           style="max-width:360px; border-radius:18px;">
        <p class="modelo-popover__titulo" style="color:var(--gold)">Novo exercício em ${escapar(divisao.nome)}</p>
        <label class="rotina-campo-rotulado" style="margin-top:12px;">
          <span>Nome</span>
          <input class="rotina-campo" type="text" data-exercicio-nome placeholder="Ex.: Supino reto">
        </label>
        <label class="rotina-campo-rotulado">
          <span>Músculo</span>
          <input class="rotina-campo" type="text" data-exercicio-musculo list="rotina-musculos-datalist" placeholder="Ex.: Peito">
          <datalist id="rotina-musculos-datalist">
            ${divisao.musculos.map((m) => `<option value="${escapar(m)}"></option>`).join('')}
          </datalist>
        </label>
        <div style="display:flex; gap:10px;">
          <label class="rotina-campo-rotulado" style="flex:1;">
            <span>Séries (meta)</span>
            <input class="rotina-campo" type="number" min="1" data-exercicio-series value="3">
          </label>
          <label class="rotina-campo-rotulado" style="flex:1;">
            <span>Repetições (meta)</span>
            <input class="rotina-campo" type="number" min="1" data-exercicio-repeticoes value="10">
          </label>
        </div>
        <button class="btn btn--gold" type="button" data-acao="confirmar-exercicio" data-divisao="${divisao.id}"
                style="width:100%; margin-top:14px;">
          Adicionar exercício
        </button>
      </div>
    </div>
  `;
}

/* ==================================================================
   8. CARD — SAÚDE (Sono + Nutrição fundidos)
   ================================================================== */

function htmlSaude(protocolo) {
  const { sono, nutricao } = protocolo;
  const pct = Math.min(100, (nutricao.aguaL / META_AGUA_L) * 100);

  return `
    <article class="card-exec">
      <header class="card-exec__topo"><span class="card-exec__label">Saúde</span></header>

      <p class="rotina-campo-rotulado__span">Sono & prontidão</p>
      <label class="rotina-campo-rotulado">
        <span>Horas dormidas</span>
        <input class="rotina-campo" type="number" min="0" max="14" step="0.5" data-sono-horas
               value="${sono.horas ?? ''}" placeholder="--">
      </label>
      <p class="rotina-campo-rotulado__span">Energia ao acordar</p>
      <div class="rotina-energia" role="group" aria-label="Energia de 1 a 5">
        ${[1, 2, 3, 4, 5].map((n) => `
          <button class="rotina-energia__ponto ${sono.energia === n ? 'is-selecionado' : ''}"
                  type="button" data-sono-energia="${n}" aria-pressed="${sono.energia === n}"
                  aria-label="Energia ${n} de 5">${n}</button>
        `).join('')}
      </div>

      <p class="rotina-campo-rotulado__span">Hidratação & nutrição</p>
      <div class="rotina-agua">
        <button class="rotina-agua__btn" type="button" data-agua="-0.25" aria-label="Remover 250ml">−</button>
        <span class="rotina-agua__valor">${nutricao.aguaL.toFixed(2).replace('.', ',')} L</span>
        <button class="rotina-agua__btn" type="button" data-agua="0.25" aria-label="Adicionar 250ml">+</button>
      </div>
      <div class="rotina-agua__trilho" role="img" aria-label="${pct.toFixed(0)}% da meta de ${META_AGUA_L}L">
        <span class="rotina-agua__preenchido" style="width:${pct}%"></span>
      </div>

      <ul class="rotina-checklist">
        ${REFEICOES.map((r) => `
          <li>
            <button class="rotina-checklist__item ${nutricao.refeicoes[r] ? 'is-feita' : ''}"
                    type="button" data-refeicao="${escapar(r)}" aria-pressed="${nutricao.refeicoes[r]}">
              <span class="rotina-checklist__caixa" aria-hidden="true"></span>
              ${escapar(r)}
            </button>
          </li>
        `).join('')}
      </ul>

      <input class="rotina-campo" type="text" data-suplementacao placeholder="Suplementação (livre)"
             value="${escapar(nutricao.suplementacao)}">

      <p class="section__nota" style="margin-top:14px;">
        Diagnóstico 24h por smartwatch: ainda não conectado — este espaço já está
        reservado para quando essa integração existir.
      </p>
    </article>
  `;
}

/* ==================================================================
   9. LINHA DO TEMPO DO DIA
   ================================================================== */

const HORA_INICIO = 6;
const HORA_FIM = 23;

function htmlTimelineDia(protocolo, chave) {
  const ehHoje = chave === chaveDia(hoje());
  const agora = new Date();
  const minutosAgora = agora.getHours() * 60 + agora.getMinutes();
  const minutosTotais = (HORA_FIM - HORA_INICIO) * 60;
  const posAgora = ((minutosAgora - HORA_INICIO * 60) / minutosTotais) * 100;

  const horas = [];
  for (let h = HORA_INICIO; h <= HORA_FIM; h++) horas.push(h);

  return `
    <div class="rotina-timeline">
      ${ehHoje && posAgora >= 0 && posAgora <= 100 ? `
        <div class="rotina-timeline__agora" style="top:${posAgora}%">
          <span class="rotina-timeline__agora-ponto" aria-hidden="true"></span>
          <span class="rotina-timeline__agora-hora">${doisDigitos(agora.getHours())}:${doisDigitos(agora.getMinutes())}</span>
        </div>
      ` : ''}
      ${horas.map((h) => `
        <div class="rotina-timeline__linha">
          <span class="rotina-timeline__hora">${doisDigitos(h)}:00</span>
          <span class="rotina-timeline__trilho"></span>
        </div>
      `).join('')}
    </div>
    ${!protocolo.compromissos.length ? `
      <p class="rotina-timeline__vazio">
        Nenhum compromisso ainda. A sincronização com o Google Calendar não existe de
        verdade por enquanto — use o "+" no card de Agenda mensal para adicionar na mão.
      </p>
    ` : `
      <ul class="rotina-compromissos-lista">
        ${protocolo.compromissos.map((c) => `
          <li>
            <span class="rotina-compromissos-lista__nome">${escapar(c.titulo)}</span>
            ${c.origem === 'manual' ? '<span class="badge-categoria">Manual</span>' : ''}
          </li>
        `).join('')}
      </ul>
    `}
  `;
}

/* ==================================================================
   10. CARD — AGENDA MENSAL (grade do mês + seletor de mês/ano)
   ================================================================== */

function htmlSeletorMesAno() {
  if (seletorMesAnoAberto === 'ano') {
    const inicioFaixa = Math.floor((anoDoSeletor - 2025) / 12) * 12 + 2025;
    return `
      <div class="rotina-seletor-mesano">
        <div class="rotina-nav-dia">
          <button class="nav-mes__seta" type="button" data-faixa-ano="-1" aria-label="Faixa de anos anterior">${SVG_SETA_ESQ}</button>
          <span class="rotina-nav-dia__rotulo">${inicioFaixa} - ${inicioFaixa + 11}</span>
          <button class="nav-mes__seta" type="button" data-faixa-ano="1" aria-label="Próxima faixa de anos">${SVG_SETA_DIR}</button>
        </div>
        <div class="rotina-grade-anos">
          ${Array.from({ length: 12 }, (_, i) => inicioFaixa + i).map((a) => `
            <button class="rotina-grade-anos__item ${a === mesAtivo.ano ? 'is-ativo' : ''}" type="button" data-escolher-ano="${a}">${a}</button>
          `).join('')}
        </div>
      </div>
    `;
  }
  if (seletorMesAnoAberto === 'mes') {
    return `
      <div class="rotina-seletor-mesano">
        <div class="rotina-nav-dia">
          <button class="nav-mes__seta" type="button" data-mes-seletor-ano="-1" aria-label="Ano anterior">${SVG_SETA_ESQ}</button>
          <button class="rotina-nav-dia__rotulo" type="button" data-abrir-seletor="ano" style="background:none; border:0;">${anoDoSeletor}</button>
          <button class="nav-mes__seta" type="button" data-mes-seletor-ano="1" aria-label="Próximo ano">${SVG_SETA_DIR}</button>
        </div>
        <div class="rotina-grade-anos">
          ${MESES.map((m, i) => `
            <button class="rotina-grade-anos__item ${i === mesAtivo.mes && anoDoSeletor === mesAtivo.ano ? 'is-ativo' : ''}"
                    type="button" data-escolher-mes="${i}">${m.slice(0, 3)}.</button>
          `).join('')}
        </div>
      </div>
    `;
  }
  return '';
}

function htmlAgendaMensal() {
  const { ano, mes } = mesAtivo;
  const celulas = celulasDoMes(ano, mes);
  const chaveHoje = chaveDia(hoje());

  return `
    <article class="card-exec card-exec--largo">
      <header class="card-exec__topo"><span class="card-exec__label">Agenda mensal</span></header>

      <div class="rotina-nav-dia">
        <button class="nav-mes__seta" type="button" data-mes-nav="-1" aria-label="Mês anterior">${SVG_SETA_ESQ}</button>
        <button class="rotina-nav-dia__rotulo" type="button" data-abrir-seletor="mes" style="background:none; border:0;">
          ${MESES[mes]} de ${ano}
        </button>
        <button class="nav-mes__seta" type="button" data-mes-nav="1" aria-label="Próximo mês">${SVG_SETA_DIR}</button>
      </div>

      ${htmlSeletorMesAno()}

      <div class="rotina-grade-mes">
        ${DIAS_SEMANA.map((d) => `<span class="rotina-grade-mes__cabecalho">${d}</span>`).join('')}
        ${celulas.map((c) => {
          const chave = chaveDia(c.data);
          const protocolo = protocoloPorDia[chave];
          const temAtividade = protocolo && (
            Object.values(protocolo.tarefasFixas).some(Boolean)
            || Object.values(protocolo.treino.registros).some((r) => r.series.length)
          );
          const temCompromisso = protocolo?.compromissos.length > 0;
          return `
            <button class="rotina-grade-mes__dia ${c.foraDoMes ? 'is-fora' : ''} ${chave === chaveHoje ? 'is-hoje' : ''}"
                    type="button" data-dia-mes="${chave}">
              <span>${c.data.getDate()}</span>
              ${temCompromisso ? '<span class="rotina-grade-mes__ponto rotina-grade-mes__ponto--compromisso" aria-hidden="true"></span>'
                : temAtividade ? '<span class="rotina-grade-mes__ponto" aria-hidden="true"></span>' : ''}
            </button>
          `;
        }).join('')}
      </div>

      <div class="rotina-add-rapido">
        <input class="rotina-campo" type="text" data-novo-compromisso
               placeholder="Adic. em ${dataDaChave(diaAtivo).getDate()} de ${MESES[dataDaChave(diaAtivo).getMonth()].toLowerCase()}">
        <button class="rotina-add-rapido__btn" type="button" data-acao="adicionar-compromisso" aria-label="Adicionar compromisso">+</button>
      </div>
    </article>
  `;
}

/* ==================================================================
   11. SEGUNDO CÉREBRO — busca + tag + título opcional
   ================================================================== */

function htmlNota(n) {
  return `
    <article class="rotina-nota">
      ${n.titulo ? `<p class="rotina-nota__titulo">${escapar(n.titulo)}</p>` : ''}
      <p class="rotina-nota__texto">${escapar(n.texto)}</p>
      <div class="rotina-nota__rodape">
        <div class="rotina-nota__tags">
          ${n.tags.map((t) => `<span class="badge-categoria">${escapar(t)}</span>`).join('')}
        </div>
        <button class="rotina-nota__forjar ${n.forjada ? 'is-forjada' : ''}" type="button"
                data-forjar="${n.id}" ${n.forjada ? 'disabled' : ''}>
          ${SVG_FORJA} ${n.forjada ? 'Forjado no Conselho' : 'Forjar no Conselho'}
        </button>
      </div>
    </article>
  `;
}

function htmlSegundoCerebro() {
  const lista = notasFiltradas();
  return `
    <section class="section" data-regiao="segundo-cerebro">
      <p class="section__label">Segundo cérebro</p>

      <div class="rotina-nova-nota">
        <input class="rotina-campo" type="text" data-nova-nota-titulo placeholder="Título (opcional)">
        <textarea class="rotina-campo" data-nova-nota rows="2"
                  placeholder="Uma ideia, um trecho, um rascunho…"></textarea>
        <div class="rotina-nova-nota__tags" role="group" aria-label="Categorias — a categorização automática ainda não existe, escolha manualmente">
          ${TAGS_DISPONIVEIS.map((t) => `
            <button class="rotina-nova-nota__tag" type="button" data-tag-selecionar="${escapar(t)}"
                    aria-pressed="false">${escapar(t)}</button>
          `).join('')}
        </div>
        <button class="btn btn--gold" type="button" data-acao="salvar-nota">Salvar nota</button>
      </div>

      <div class="rotina-busca">
        <span class="rotina-busca__icone" aria-hidden="true">${SVG_BUSCA}</span>
        <input class="rotina-campo rotina-busca__campo" type="search" data-buscar-notas
               placeholder="Buscar nas notas…" value="${escapar(buscaNotas)}">
      </div>
      <div class="rotina-nova-nota__tags" role="group" aria-label="Filtrar por tag" style="margin-bottom:12px;">
        ${TAGS_DISPONIVEIS.map((t) => `
          <button class="rotina-nova-nota__tag ${tagFiltroNotas === t ? 'is-selecionada' : ''}" type="button"
                  data-tag-filtro="${escapar(t)}" aria-pressed="${tagFiltroNotas === t}">${escapar(t)}</button>
        `).join('')}
      </div>

      <div class="rotina-notas" data-regiao="notas">
        ${lista.length
          ? lista.map(htmlNota).join('')
          : notas.length
            ? `<p class="rotina-notas__vazio">Nenhuma nota bate com essa busca/filtro.</p>`
            : `<p class="rotina-notas__vazio">Nenhuma nota ainda. É aqui que as ideias soltas viram dossiê estruturado.</p>`}
      </div>
    </section>
  `;
}

/* ==================================================================
   12. MÓDULO
   ================================================================== */
let raiz = null;
let aoClicar = null;
let aoDigitar = null;
let tagsSelecionadasNovaNota = new Set();

function anunciar(label, tone) {
  document.dispatchEvent(new CustomEvent('sanco:status', { detail: { label, tone } }));
}

function statusAtual() {
  const protocolo = protocoloDe(chaveDia(hoje()));
  const feitas = Object.values(protocolo.tarefasFixas).filter(Boolean).length;
  const total = TAREFAS_FIXAS.length;
  if (feitas === total) return anunciar('Rotina do dia em dia', 'secure');
  return anunciar(`${feitas}/${total} tarefas hoje`, feitas > 0 ? 'pending' : 'offline');
}

/** Redesenha o conteúdo principal — cabeçalho (dia ativo) fica no lugar. */
function desenhar() {
  if (!raiz) return;

  const rotuloRegiao = raiz.querySelector('[data-regiao="rotulo-dia"]');
  if (rotuloRegiao) rotuloRegiao.textContent = rotuloDia(diaAtivo);

  const conteudo = raiz.querySelector('[data-regiao="conteudo"]');
  if (conteudo) {
    if (telaTreino) {
      conteudo.innerHTML = `<div class="section">${htmlExercicioDetalhe(telaTreino.exercicioId)}</div>`;
    } else {
      const protocolo = protocoloDe(diaAtivo);
      conteudo.innerHTML = `
        <div class="fin-cards fin-cards--tres">
          ${htmlTarefasFixas(protocolo)}
          ${htmlTreinoPainel(protocolo)}
          ${htmlSaude(protocolo)}
        </div>

        ${htmlAgendaMensal()}

        <section class="section">
          <p class="section__label">Linha do tempo — ${rotuloDia(diaAtivo)}</p>
          ${htmlTimelineDia(protocolo, diaAtivo)}
        </section>

        ${divisaoSheetAberta ? htmlFormNovaDivisao() : ''}
        ${exercicioSheetDivisaoId ? htmlFormNovoExercicio(exercicioSheetDivisaoId) : ''}
      `;
    }
  }

  const cerebro = raiz.querySelector('[data-regiao="segundo-cerebro"]');
  if (cerebro) cerebro.outerHTML = htmlSegundoCerebro();

  statusAtual();
}

const agenda = {
  id: 'agenda',
  title: 'Rotina',

  render() {
    const view = document.createElement('section');
    view.dataset.module = this.id;

    view.innerHTML = `
      <header class="view__head">
        <span class="view__eyebrow" data-regiao="rotulo-dia">${rotuloDia(diaAtivo)}</span>
        <h1 class="view__title">Rotina</h1>
      </header>

      <div class="rotina-nav-dia">
        <button class="nav-mes__seta" type="button" data-dia="-1" aria-label="Dia anterior">${SVG_SETA_ESQ}</button>
        <span class="rotina-nav-dia__rotulo">${rotuloDia(diaAtivo)}</span>
        <button class="nav-mes__seta" type="button" data-dia="1" aria-label="Próximo dia">${SVG_SETA_DIR}</button>
      </div>

      <div data-regiao="conteudo"></div>

      ${htmlSegundoCerebro()}
    `;

    return view;
  },

  mount(view) {
    raiz = view;
    statusAtual();
    desenhar();

    aoClicar = (evento) => {
      // --- navegação de dia (governa Tarefas/Treino/Saúde/Timeline) ---
      const diaNav = evento.target.closest('[data-dia]');
      if (diaNav) {
        diaAtivo = chaveDia(somarDias(dataDaChave(diaAtivo), Number(diaNav.dataset.dia)));
        telaTreino = null;
        return desenhar();
      }

      // --- card de Agenda mensal ---
      const mesNav = evento.target.closest('[data-mes-nav]');
      if (mesNav) {
        const passo = Number(mesNav.dataset.mesNav);
        const d = new Date(mesAtivo.ano, mesAtivo.mes + passo, 1);
        mesAtivo = { ano: d.getFullYear(), mes: d.getMonth() };
        return desenhar();
      }

      const diaMes = evento.target.closest('[data-dia-mes]');
      if (diaMes) {
        diaAtivo = diaMes.dataset.diaMes;
        const d = dataDaChave(diaAtivo);
        mesAtivo = { ano: d.getFullYear(), mes: d.getMonth() };
        return desenhar();
      }

      const abrirSeletor = evento.target.closest('[data-abrir-seletor]');
      if (abrirSeletor) {
        seletorMesAnoAberto = abrirSeletor.dataset.abrirSeletor;
        anoDoSeletor = mesAtivo.ano;
        return desenhar();
      }

      const faixaAno = evento.target.closest('[data-faixa-ano]');
      if (faixaAno) { anoDoSeletor += Number(faixaAno.dataset.faixaAno) * 12; return desenhar(); }

      const mesSeletorAno = evento.target.closest('[data-mes-seletor-ano]');
      if (mesSeletorAno) { anoDoSeletor += Number(mesSeletorAno.dataset.mesSeletorAno); return desenhar(); }

      const escolherAno = evento.target.closest('[data-escolher-ano]');
      if (escolherAno) {
        anoDoSeletor = Number(escolherAno.dataset.escolherAno);
        seletorMesAnoAberto = 'mes';
        return desenhar();
      }

      const escolherMes = evento.target.closest('[data-escolher-mes]');
      if (escolherMes) {
        mesAtivo = { ano: anoDoSeletor, mes: Number(escolherMes.dataset.escolherMes) };
        seletorMesAnoAberto = false;
        return desenhar();
      }

      if (evento.target.closest('[data-acao="adicionar-compromisso"]')) {
        const campo = raiz.querySelector('[data-novo-compromisso]');
        const titulo = campo?.value.trim();
        if (!titulo) return;
        protocoloDe(diaAtivo).compromissos.push({ titulo, origem: 'manual' });
        campo.value = '';
        return desenhar();
      }

      // --- protocolo biológico: tarefas, sono, nutrição ---
      const tarefaFixa = evento.target.closest('[data-tarefa-fixa]');
      if (tarefaFixa) {
        const p = protocoloDe(diaAtivo);
        const chave = tarefaFixa.dataset.tarefaFixa;
        p.tarefasFixas[chave] = !p.tarefasFixas[chave];
        return desenhar();
      }

      const energiaBtn = evento.target.closest('[data-sono-energia]');
      if (energiaBtn) {
        const p = protocoloDe(diaAtivo);
        p.sono.energia = Number(energiaBtn.dataset.sonoEnergia);
        return desenhar();
      }

      const aguaBtn = evento.target.closest('[data-agua]');
      if (aguaBtn) {
        const p = protocoloDe(diaAtivo);
        p.nutricao.aguaL = Math.max(0, p.nutricao.aguaL + Number(aguaBtn.dataset.agua));
        return desenhar();
      }

      const refeicaoBtn = evento.target.closest('[data-refeicao]');
      if (refeicaoBtn) {
        const p = protocoloDe(diaAtivo);
        const chave = refeicaoBtn.dataset.refeicao;
        p.nutricao.refeicoes[chave] = !p.nutricao.refeicoes[chave];
        return desenhar();
      }

      // --- treino: escolher/criar divisão, abrir/fechar exercício ---
      const escolherDivisao = evento.target.closest('[data-escolher-divisao]');
      if (escolherDivisao) {
        protocoloDe(diaAtivo).treino.divisaoId = Number(escolherDivisao.dataset.escolherDivisao);
        return desenhar();
      }

      if (evento.target.closest('[data-acao="trocar-divisao"]')) {
        protocoloDe(diaAtivo).treino.divisaoId = null;
        return desenhar();
      }

      if (evento.target.closest('[data-acao="nova-divisao"]')) {
        divisaoSheetAberta = true;
        return desenhar();
      }
      if (evento.target.closest('[data-fechar-form-divisao]')) {
        divisaoSheetAberta = false;
        return desenhar();
      }
      if (evento.target.closest('[data-acao="confirmar-divisao"]')) {
        const nomeCampo = raiz.querySelector('[data-divisao-nome]');
        const musculosCampo = raiz.querySelector('[data-divisao-musculos]');
        const nome = nomeCampo?.value.trim();
        if (!nome) return nomeCampo?.focus();
        const musculos = (musculosCampo?.value ?? '').split(',').map((m) => m.trim()).filter(Boolean);
        divisoesTreino.push({ id: proximaDivisaoId++, nome, musculos, exercicios: [] });
        divisaoSheetAberta = false;
        return desenhar();
      }

      const abrirExercicio = evento.target.closest('[data-abrir-exercicio]');
      if (abrirExercicio) {
        telaTreino = { exercicioId: Number(abrirExercicio.dataset.abrirExercicio) };
        return desenhar();
      }
      if (evento.target.closest('[data-acao="fechar-exercicio"]')) {
        telaTreino = null;
        return desenhar();
      }
      if (evento.target.closest('[data-acao="registrar-serie"]')) {
        const btn = evento.target.closest('[data-acao="registrar-serie"]');
        const exercicioId = Number(btn.dataset.exercicio);
        const pesoCampo = raiz.querySelector('[data-serie-peso]');
        const repsCampo = raiz.querySelector('[data-serie-repeticoes]');
        const peso = pesoCampo?.value === '' ? null : Number(pesoCampo.value);
        const repeticoes = repsCampo?.value === '' ? null : Number(repsCampo.value);
        if (peso === null && repeticoes === null) return;

        const p = protocoloDe(diaAtivo);
        if (!p.treino.registros[exercicioId]) p.treino.registros[exercicioId] = { series: [] };
        p.treino.registros[exercicioId].series.push({ peso, repeticoes });
        return desenhar();
      }

      // --- exercício novo, dentro de uma divisão ---
      const abrirFormExercicio = evento.target.closest('[data-acao="abrir-novo-exercicio"]');
      if (abrirFormExercicio) {
        exercicioSheetDivisaoId = Number(abrirFormExercicio.dataset.divisao);
        return desenhar();
      }
      if (evento.target.closest('[data-fechar-form-exercicio]')) {
        exercicioSheetDivisaoId = null;
        return desenhar();
      }
      if (evento.target.closest('[data-acao="confirmar-exercicio"]')) {
        const btn = evento.target.closest('[data-acao="confirmar-exercicio"]');
        const divisao = divisaoPorId(Number(btn.dataset.divisao));
        if (!divisao) return;
        const nomeCampo = raiz.querySelector('[data-exercicio-nome]');
        const nome = nomeCampo?.value.trim();
        if (!nome) return nomeCampo?.focus();
        const musculo = raiz.querySelector('[data-exercicio-musculo]')?.value.trim() || 'Geral';
        const seriesMeta = Number(raiz.querySelector('[data-exercicio-series]')?.value) || 3;
        const repeticoesMeta = Number(raiz.querySelector('[data-exercicio-repeticoes]')?.value) || 10;
        divisao.exercicios.push({ id: proximoExercicioId++, nome, musculo, seriesMeta, repeticoesMeta });
        exercicioSheetDivisaoId = null;
        return desenhar();
      }

      // --- segundo cérebro ---
      const tagBtn = evento.target.closest('[data-tag-selecionar]');
      if (tagBtn) {
        const t = tagBtn.dataset.tagSelecionar;
        if (tagsSelecionadasNovaNota.has(t)) tagsSelecionadasNovaNota.delete(t);
        else tagsSelecionadasNovaNota.add(t);
        tagBtn.setAttribute('aria-pressed', String(tagsSelecionadasNovaNota.has(t)));
        tagBtn.classList.toggle('is-selecionada', tagsSelecionadasNovaNota.has(t));
        return;
      }

      const tagFiltroBtn = evento.target.closest('[data-tag-filtro]');
      if (tagFiltroBtn) {
        const t = tagFiltroBtn.dataset.tagFiltro;
        tagFiltroNotas = tagFiltroNotas === t ? null : t;
        return desenhar();
      }

      if (evento.target.closest('[data-acao="salvar-nota"]')) {
        if (!sessaoLiberada()) return;
        const tituloCampo = raiz.querySelector('[data-nova-nota-titulo]');
        const campo = raiz.querySelector('[data-nova-nota]');
        const texto = campo.value.trim();
        if (!texto) return;
        notas.unshift({
          id: proximaNotaId++,
          titulo: tituloCampo?.value.trim() || null,
          texto,
          tags: [...tagsSelecionadasNovaNota],
          forjada: false
        });
        tagsSelecionadasNovaNota = new Set();
        return desenhar();
      }

      const forjarBtn = evento.target.closest('[data-forjar]');
      if (forjarBtn) {
        const nota = notas.find((n) => n.id === Number(forjarBtn.dataset.forjar));
        if (!nota) return;
        // Sem integração com panteao.js ainda — "forjar" registra a
        // intenção. Quando a ponte existir, isto abre uma conversa do
        // Conselho com o texto da nota e dispara a colaboração multiagente.
        console.info('[rotina] "Forjar no Conselho" ainda não conectado ao Panteão — nota:', nota.texto);
        nota.forjada = true;
        return desenhar();
      }
    };

    aoDigitar = (evento) => {
      if (evento.target.matches('[data-sono-horas]')) {
        protocoloDe(diaAtivo).sono.horas = evento.target.value === '' ? null : Number(evento.target.value);
      } else if (evento.target.matches('[data-suplementacao]')) {
        protocoloDe(diaAtivo).nutricao.suplementacao = evento.target.value;
      } else if (evento.target.matches('[data-buscar-notas]')) {
        buscaNotas = evento.target.value;
        const notasRegiao = raiz.querySelector('[data-regiao="notas"]');
        if (notasRegiao) {
          const lista = notasFiltradas();
          notasRegiao.innerHTML = lista.length
            ? lista.map(htmlNota).join('')
            : notas.length
              ? `<p class="rotina-notas__vazio">Nenhuma nota bate com essa busca/filtro.</p>`
              : `<p class="rotina-notas__vazio">Nenhuma nota ainda. É aqui que as ideias soltas viram dossiê estruturado.</p>`;
        }
      }
    };

    view.addEventListener('click', aoClicar);
    view.addEventListener('input', aoDigitar);
  },

  unmount() {
    if (raiz) {
      raiz.removeEventListener('click', aoClicar);
      raiz.removeEventListener('input', aoDigitar);
    }
    aoClicar = null;
    aoDigitar = null;
    raiz = null;
    telaTreino = null;
    divisaoSheetAberta = false;
    exercicioSheetDivisaoId = null;
    seletorMesAnoAberto = false;
  }
};

export default agenda;
