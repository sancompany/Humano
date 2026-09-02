/**
 * SAN & CO. — sub-tela Projetos (dentro do módulo Finanças)
 *
 * Auto-provisionamento via checkout (Asaas): handleCheckoutEvent() em
 * dados.js é a função que o backend vai chamar quando o webhook existir.
 * Por enquanto, sem webhook nenhum, o único jeito real de um projeto
 * nascer aqui é o botão "+ Vincular Checkout / Manual" — que usa
 * criarProjetoManual(), o mesmo molde que o webhook usaria.
 *
 * Escopo (Pessoal/Comercial) é independente do seletor global PF/PJ do
 * Financeiro: PF/PJ é sobre CPF/CNPJ, escopo é sobre "é meu ou é de
 * cliente". Por isso o filtro de escopo vive só aqui dentro, local a
 * esta sub-tela.
 */

import { estado, observar } from '../state.js';
import { projetosDe, criarProjetoManual } from '../dados.js';

/* ------------------------------------------------------------------
   1. FORMATAÇÃO
------------------------------------------------------------------ */
const FORMATO_BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 });
const VALOR_VAZIO = 'R$ ---.---,--';

function brl(valor) {
  return Number.isFinite(valor) ? FORMATO_BRL.format(valor) : VALOR_VAZIO;
}
function brlHtml(valor) {
  const texto = brl(valor);
  return texto === VALOR_VAZIO ? `<span class="valor-vazio">${texto}</span>` : texto;
}
function escapar(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ------------------------------------------------------------------
   2. FILTROS — locais a esta tela
------------------------------------------------------------------ */
let escopoAtivo = 'pessoal';    // 'pessoal' | 'comercial'
let statusAtivo = 'todos';      // 'todos' | 'ativo' | 'construcao' | 'desativado'
let gavetaVincularAberta = false;

export const STATUS_ROTULO = { ativo: 'Ativos / Operando', construcao: 'Em Construção', desativado: 'Desativados' };
export const STATUS_COR = { ativo: 'var(--success)', construcao: 'var(--warn)', desativado: 'var(--danger)' };

/* ------------------------------------------------------------------
   3. FRAGMENTOS
------------------------------------------------------------------ */

function htmlSeletorEscopo(projetos) {
  const contagem = (escopo) => projetos.filter((p) => p.escopo === escopo).length;
  return `
    <div class="escopo-seletor" role="group" aria-label="Escopo dos projetos">
      <button class="escopo-seletor__btn ${escopoAtivo === 'pessoal' ? 'is-ativo' : ''}"
              type="button" data-escopo="pessoal" aria-pressed="${escopoAtivo === 'pessoal'}">
        Meus projetos pessoais <span class="escopo-seletor__conta">${contagem('pessoal')}</span>
      </button>
      <button class="escopo-seletor__btn ${escopoAtivo === 'comercial' ? 'is-ativo' : ''}"
              type="button" data-escopo="comercial" aria-pressed="${escopoAtivo === 'comercial'}">
        Projetos comerciais / clientes <span class="escopo-seletor__conta">${contagem('comercial')}</span>
      </button>
    </div>
  `;
}

function htmlFiltrosStatus(doEscopo) {
  const contagem = (status) => status === 'todos' ? doEscopo.length : doEscopo.filter((p) => p.status === status).length;
  const opcoes = [['todos', 'Todos'], ['ativo', 'Ativos'], ['construcao', 'Em Construção'], ['desativado', 'Desativados']];

  return `
    <div class="projetos-toolbar">
      <div class="lentes" role="group" aria-label="Filtro de status">
        ${opcoes.map(([valor, texto]) => `
          <button class="lentes__btn" type="button" data-status="${valor}"
                  aria-pressed="${statusAtivo === valor}">
            ${texto} <span class="lentes__conta">${contagem(valor)}</span>
          </button>
        `).join('')}
      </div>
      <button class="btn btn--gold" type="button" data-acao="abrir-vincular">+ Vincular Checkout / Manual</button>
    </div>
  `;
}

export function htmlSparkline(historico) {
  const valores = historico.filter((v) => Number.isFinite(v));
  if (valores.length < 2) return '<p class="projeto-card__sem-historico">Sem histórico suficiente ainda.</p>';

  const max = Math.max(...valores, 1);
  return `
    <div class="projeto-sparkline" role="img" aria-label="Faturamento dos últimos 6 meses">
      ${historico.map((v) => `
        <span class="projeto-sparkline__barra" style="height:${Number.isFinite(v) ? Math.max(4, (v / max) * 100) : 2}%"
              title="${Number.isFinite(v) ? brl(v) : 'Sem dado'}"></span>
      `).join('')}
    </div>
  `;
}

function htmlCardProjeto(p) {
  const lucroBom = Number.isFinite(p.lucroLiquido) && p.lucroLiquido >= 0;
  return `
    <article class="projeto-card" data-clickable="true" role="button" tabindex="0" data-projeto-id="${escapar(p.id)}"
             aria-label="${escapar(p.nome)}, faturamento do mês ${brl(p.faturamentoMes)}. Abrir detalhamento.">
      <header class="projeto-card__topo">
        <div>
          <p class="projeto-card__nome">${escapar(p.nome)}</p>
          <p class="projeto-card__categoria">${escapar(p.categoria)}</p>
        </div>
        <span class="projeto-card__status" style="--status: ${STATUS_COR[p.status]}">
          ${STATUS_ROTULO[p.status]}
        </span>
      </header>

      <p class="projeto-card__faturamento">${brlHtml(p.faturamentoMes)}</p>
      <p class="projeto-card__sub">Faturamento do mês</p>

      <div class="projeto-card__grade">
        <div><span>Lucro líquido</span><strong class="${!Number.isFinite(p.lucroLiquido) ? '' : lucroBom ? 'extrato__valor--entrada' : 'extrato__valor--saida'}">${brlHtml(p.lucroLiquido)}</strong></div>
        <div><span>Margem</span><strong>${Number.isFinite(p.margemLucro) ? `${p.margemLucro}%` : '--%'}</strong></div>
        <div><span>Ticket médio</span><strong>${brlHtml(p.kpis.ticketMedio)}</strong></div>
      </div>

      ${htmlSparkline(p.historico6m)}

      <p class="projeto-card__diagnostico">
        ${p.diagnosticoIA
          ? escapar(p.diagnosticoIA)
          : 'Lumen Lux ainda não tem diagnóstico — sem IA conectada, nada é dito no lugar dela.'}
      </p>
    </article>
  `;
}

function htmlGrade(doEscopo) {
  const filtrados = statusAtivo === 'todos' ? doEscopo : doEscopo.filter((p) => p.status === statusAtivo);
  if (!filtrados.length) {
    return `
      <div class="slot">
        <span class="slot__mark" aria-hidden="true"></span>
        <p class="slot__text">
          ${doEscopo.length
            ? 'Nenhum projeto neste status.'
            : 'Nenhum projeto neste escopo ainda. Vincule um checkout ou crie manualmente.'}
        </p>
      </div>
    `;
  }
  return `<div class="projetos-grade">${filtrados.map(htmlCardProjeto).join('')}</div>`;
}

/** Formulário de vínculo manual — hoje é o único caminho real de criação. */
function htmlGavetaVincular() {
  return `
    <div class="anexo-sheet" data-regiao="vincular-sheet" ${gavetaVincularAberta ? '' : 'hidden'}>
      <div class="anexo-sheet__fundo" data-vincular-fechar aria-hidden="true"></div>
      <div class="anexo-sheet__painel" role="dialog" aria-modal="true" aria-label="Vincular checkout ou criar projeto manual"
           style="max-width: 360px; border-radius: 18px;">
        <p class="modelo-popover__titulo" style="color:var(--gold)">Vincular Checkout / Manual</p>
        <p class="section__nota" style="margin-top:-2px;">
          Sem o webhook do Asaas ainda, isto cria o projeto direto — mesmo
          molde que o checkout usaria quando a integração existir.
        </p>

        <label class="rotina-campo-rotulado" style="margin-top:14px;">
          <span>Nome do projeto</span>
          <input class="rotina-campo" type="text" data-vincular-nome placeholder="Ex.: Academia BJJ">
        </label>

        <p class="rotina-campo-rotulado__span">Escopo</p>
        <div class="escopo-seletor" role="group" aria-label="Escopo do novo projeto">
          <button class="escopo-seletor__btn is-ativo" type="button" data-vincular-escopo="pessoal" aria-pressed="true">Pessoal</button>
          <button class="escopo-seletor__btn" type="button" data-vincular-escopo="comercial" aria-pressed="false">Comercial</button>
        </div>

        <label class="rotina-campo-rotulado" style="margin-top:10px;">
          <span>Categoria (opcional)</span>
          <input class="rotina-campo" type="text" data-vincular-categoria placeholder="Ex.: SaaS, Serviço, Varejo">
        </label>

        <button class="btn btn--gold" type="button" data-acao="confirmar-vincular" style="width:100%; margin-top:16px;">
          Criar projeto
        </button>
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------
   4. MÓDULO
------------------------------------------------------------------ */
let raiz = null;
let aoClicar = null;
let aoTeclar = null;
let cancelarObservador = null;
let escopoFormulario = 'pessoal';

function redesenhar() {
  if (!raiz) return;
  const doPerfil = projetosDe(estado.perfil);
  const doEscopo = doPerfil.filter((p) => p.escopo === escopoAtivo);

  const area = raiz.querySelector('[data-regiao="conteudo-projetos"]');
  if (area) {
    area.innerHTML = `
      ${htmlSeletorEscopo(doPerfil)}
      ${htmlFiltrosStatus(doEscopo)}
      ${htmlGrade(doEscopo)}
    `;
  }

  const gaveta = raiz.querySelector('[data-regiao="vincular-sheet"]');
  if (gaveta) gaveta.outerHTML = htmlGavetaVincular();
}

const projetosModulo = {
  id: 'projetos',

  render() {
    const bloco = document.createElement('div');
    bloco.dataset.subtela = this.id;
    bloco.innerHTML = `
      <div data-regiao="conteudo-projetos"></div>
      ${htmlGavetaVincular()}
    `;
    return bloco;
  },

  mount(view) {
    raiz = view;
    redesenhar();

    aoClicar = (evento) => {
      const abaEscopo = evento.target.closest('[data-escopo]');
      if (abaEscopo) { escopoAtivo = abaEscopo.dataset.escopo; statusAtivo = 'todos'; return redesenhar(); }

      const abaStatus = evento.target.closest('[data-status]');
      if (abaStatus) { statusAtivo = abaStatus.dataset.status; return redesenhar(); }

      if (evento.target.closest('[data-acao="abrir-vincular"]')) {
        gavetaVincularAberta = true;
        escopoFormulario = 'pessoal';
        return redesenhar();
      }
      if (evento.target.closest('[data-vincular-fechar]')) {
        gavetaVincularAberta = false;
        return redesenhar();
      }

      const escopoForm = evento.target.closest('[data-vincular-escopo]');
      if (escopoForm) {
        escopoFormulario = escopoForm.dataset.vincularEscopo;
        raiz.querySelectorAll('[data-vincular-escopo]').forEach((b) => {
          const ativo = b.dataset.vincularEscopo === escopoFormulario;
          b.classList.toggle('is-ativo', ativo);
          b.setAttribute('aria-pressed', String(ativo));
        });
        return;
      }

      if (evento.target.closest('[data-acao="confirmar-vincular"]')) {
        const nomeCampo = raiz.querySelector('[data-vincular-nome]');
        const categoriaCampo = raiz.querySelector('[data-vincular-categoria]');
        const nome = nomeCampo?.value.trim();
        if (!nome) { nomeCampo?.focus(); return; }

        criarProjetoManual(
          { nome, escopo: escopoFormulario, categoria: categoriaCampo?.value.trim() || undefined },
          estado.perfil
        );
        gavetaVincularAberta = false;
        escopoAtivo = escopoFormulario;
        statusAtivo = 'todos';
        return redesenhar();
      }

      const card = evento.target.closest('[data-projeto-id]');
      if (card) {
        window.location.hash = `#/financas/detalhe/projeto/${encodeURIComponent(card.dataset.projetoId)}`;
      }
    };

    // os cards têm tabindex mas não são <button>: o teclado precisa de ajuda
    aoTeclar = (evento) => {
      if (evento.key !== 'Enter' && evento.key !== ' ') return;
      const card = evento.target.closest('[data-projeto-id]');
      if (!card) return;
      evento.preventDefault();
      window.location.hash = `#/financas/detalhe/projeto/${encodeURIComponent(card.dataset.projetoId)}`;
    };

    view.addEventListener('click', aoClicar);
    view.addEventListener('keydown', aoTeclar);
    cancelarObservador = observar('perfil', () => redesenhar());
  },

  unmount() {
    if (raiz) {
      raiz.removeEventListener('click', aoClicar);
      raiz.removeEventListener('keydown', aoTeclar);
    }
    cancelarObservador?.();
    cancelarObservador = null;
    aoClicar = null;
    aoTeclar = null;
    raiz = null;
    gavetaVincularAberta = false;
  }
};

export default projetosModulo;
