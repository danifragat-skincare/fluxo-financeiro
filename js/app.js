import * as sync from "./sync.js";
import * as store from "./storage.js";

/* ===================== Estado ===================== */

let appData = null; // { meta, recorrentes, periods }
let currentIndex = 0;
let editingItemId = null; // null = criando nova conta
let syncTimer = null;
let periodsModalEl = null;

/* ===================== Utilitários ===================== */

const fmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
function money(v) {
  return fmt.format(v || 0);
}

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())).replace(/-/g, "").slice(0, 8);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function toNum(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function el(id) {
  return document.getElementById(id);
}

function showToast(msg, ms = 2600) {
  const t = el("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => (t.hidden = true), ms);
}

/* ===================== Cálculos de período ===================== */

function periodTotals(period) {
  let totalDespesas = 0;
  let pago = 0;
  for (const it of period.items) {
    const v = it.valor || 0;
    totalDespesas += v;
    if (it.pago) pago += v;
  }
  const entrada = period.entrada || 0;

  // Quanto dos orçamentos (ex: Mercado) ainda está reservado mas ainda não
  // foi de fato pago. Esse valor é descontado do saldo principal pra dar
  // uma visão realista do que sobra livre pra gastar — o dinheiro do
  // orçamento já está "comprometido" mesmo antes de ser lançado/pago.
  let reservaPendente = 0;
  for (const orc of appData.orcamentos || []) {
    const key = (orc.nome || "").trim().toLowerCase();
    if (!key) continue;
    const pagoCategoria = period.items
      .filter((it) => it.nome.trim().toLowerCase() === key && it.pago)
      .reduce((sum, it) => sum + (it.valor || 0), 0);
    reservaPendente += Math.max(0, (orc.valor || 0) - pagoCategoria);
  }

  return {
    entrada,
    totalDespesas,
    pago,
    falta: totalDespesas - pago,
    reservaPendente,
    // saldo = o que sobra de verdade agora na mão: o que já foi pago some,
    // e o que ainda está reservado nos orçamentos também já é descontado
    saldo: entrada - pago - reservaPendente,
    saldoPrevisto: entrada - totalDespesas,
  };
}

/** Pra cada orçamento definido (ex: "Mercado"), soma todas as contas desta
 *  quinzena com o mesmo nome (sem diferenciar maiúsculas/acentuação de caixa)
 *  e calcula quanto ainda resta do valor reservado. */
function computeOrcamentos(period) {
  return (appData.orcamentos || []).map((orc) => {
    const key = orc.nome.trim().toLowerCase();
    const gasto = period.items
      .filter((it) => it.nome.trim().toLowerCase() === key)
      .reduce((sum, it) => sum + (it.valor || 0), 0);
    return {
      ...orc,
      gasto,
      restante: orc.valor - gasto,
      pct: orc.valor > 0 ? Math.min(100, Math.round((gasto / orc.valor) * 100)) : 0,
    };
  });
}

function deriveNextPeriod(last) {
  let mes = last.mes;
  let ano = last.ano;
  let quinzena;
  let dataInicio;
  let label;
  if (last.quinzena === "A") {
    quinzena = "B";
    dataInicio = `${ano}-${pad(mes)}-20`;
    const nextMonth = mes === 12 ? 1 : mes + 1;
    label = `20/${pad(mes)} a 05/${pad(nextMonth)}`;
  } else {
    quinzena = "A";
    mes = mes === 12 ? 1 : mes + 1;
    ano = mes === 1 && last.mes === 12 ? ano + 1 : ano;
    dataInicio = `${ano}-${pad(mes)}-05`;
    label = `05/${pad(mes)} a 20/${pad(mes)}`;
  }
  return {
    id: `${ano}-${pad(mes)}-${quinzena}`,
    mes,
    ano,
    quinzena,
    dataInicio,
    label,
    entrada: 0,
    items: [],
  };
}

/* ===================== Persistência + sync ===================== */

function persistLocal() {
  store.saveLocalData(appData);
}

function markDirtyAndSync() {
  persistLocal();
  store.setDirty(true);
  setSyncIndicator("pending");
  clearTimeout(syncTimer);
  const token = store.getToken();
  if (!token) return;
  syncTimer = setTimeout(doSync, 3000);
}

function setSyncIndicator(state) {
  el("sync-status").dataset.state = state;
}

async function doSync() {
  const token = store.getToken();
  if (!token) return;
  setSyncIndicator("syncing");
  try {
    let baseSha = store.getSha();
    if (!baseSha) {
      // primeira sincronização deste aparelho: precisa saber a versão atual
      // do arquivo no GitHub antes de poder salvar por cima dela
      const remote = await sync.fetchRemote(token);
      baseSha = remote.sha || null;
      if (baseSha) store.setSha(baseSha);
    }
    const sha = await sync.pushRemote(token, appData, baseSha);
    store.setSha(sha);
    store.setDirty(false);
    setSyncIndicator("synced");
  } catch (e) {
    console.error(e);
    if (e.status === 409) {
      // alguém (outro aparelho) salvou uma versão mais nova — busca ela
      try {
        const remote = await sync.fetchRemote(token);
        appData = remote.data;
        store.setSha(remote.sha);
        persistLocal();
        store.setDirty(false);
        clampIndex();
        render();
        showToast("Havia uma versão mais nova salva — atualizei com ela.");
        setSyncIndicator("synced");
      } catch {
        setSyncIndicator("error");
      }
    } else {
      setSyncIndicator("error");
      showToast("Não consegui sincronizar: " + (e.message || "erro desconhecido"));
    }
  }
}

async function initialLoad() {
  const token = store.getToken();
  const local = store.loadLocalData();
  const dirty = store.isDirty();

  if (local) {
    appData = local;
  }

  if (token) {
    try {
      const remote = await sync.fetchRemote(token);
      if (!remote.notFound) {
        if (dirty && local) {
          // tem alterações daqui que ainda não foram enviadas — mantém o local
          // e tenta subir agora
          store.setSha(remote.sha);
          setSyncIndicator("pending");
          doSync();
        } else {
          appData = remote.data;
          store.setSha(remote.sha);
          persistLocal();
          setSyncIndicator("synced");
        }
      }
    } catch (e) {
      console.warn("Falha ao buscar do GitHub, usando cache local", e);
      setSyncIndicator(local ? "pending" : "error");
    }
  }

  if (!appData) {
    try {
      appData = await sync.fetchPublic();
    } catch {
      appData = { meta: { versao: 1 }, recorrentes: [], periods: [] };
    }
  }

  if (!appData.orcamentos) appData.orcamentos = [];
  for (const r of appData.recorrentes || []) {
    if (!r.frequencia) r.frequencia = "quinzenal";
    if (r.frequencia === "mensal" && !r.quinzenaMensal) r.quinzenaMensal = "A";
  }

  if (!appData.periods || appData.periods.length === 0) {
    const first = {
      id: `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}-A`,
      mes: new Date().getMonth() + 1,
      ano: new Date().getFullYear(),
      quinzena: "A",
      dataInicio: new Date().toISOString().slice(0, 10),
      label: "Nova quinzena",
      entrada: 0,
      items: [],
    };
    appData.periods = [first];
  }

  currentIndex = appData.periods.length - 1;
}

function clampIndex() {
  if (currentIndex >= appData.periods.length) currentIndex = appData.periods.length - 1;
  if (currentIndex < 0) currentIndex = 0;
}

/* ===================== Render ===================== */

function currentPeriod() {
  return appData.periods[currentIndex];
}

function render() {
  const period = currentPeriod();
  const totals = periodTotals(period);

  const saldoEl = el("saldo-valor");
  saldoEl.textContent = money(totals.saldo);
  saldoEl.classList.toggle("negativo", totals.saldo < 0);
  el("saldo-previsto").textContent = `previsto após pagar tudo: ${money(totals.saldoPrevisto)}`;
  const reservaEl = el("saldo-reserva");
  if (totals.reservaPendente > 0) {
    reservaEl.hidden = false;
    reservaEl.textContent = `já descontado ${money(totals.reservaPendente)} reservado em orçamentos`;
  } else {
    reservaEl.hidden = true;
  }

  el("stat-entrada").textContent = money(totals.entrada);
  el("stat-pago").textContent = money(totals.pago);
  el("stat-falta").textContent = money(totals.falta);

  el("period-text").textContent = period.label;

  el("nav-prev").disabled = currentIndex === 0;
  el("nav-prev").style.opacity = currentIndex === 0 ? 0.35 : 1;

  const isLast = currentIndex === appData.periods.length - 1;
  el("btn-new-period").hidden = !isLast;

  renderItems(period);
  renderOrcamentos(period);
  setSyncIndicator(el("sync-status").dataset.state || (store.isDirty() ? "pending" : "synced"));
}

function renderItems(period) {
  const list = el("items-list");
  list.innerHTML = "";
  const empty = el("empty-state");

  if (period.items.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  for (const it of period.items) {
    const li = document.createElement("li");
    li.className = "item-row" + (it.pago ? " pago" : "");
    li.dataset.id = it.id;

    const check = document.createElement("button");
    check.className = "item-check";
    check.setAttribute("aria-label", it.pago ? "Marcar como não pago" : "Marcar como pago");
    check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>';
    check.addEventListener("click", (ev) => {
      ev.stopPropagation();
      togglePago(it.id);
    });

    const body = document.createElement("div");
    body.className = "item-body";

    const nome = document.createElement("span");
    nome.className = "item-nome";
    nome.textContent = it.nome;
    body.appendChild(nome);

    if (it.parcela || it.nota) {
      const meta = document.createElement("span");
      meta.className = "item-meta";
      if (it.parcela) {
        const pct = Math.min(100, Math.round((it.parcela.atual / it.parcela.total) * 100));
        const badge = document.createElement("span");
        badge.className = "badge-parcela";
        badge.innerHTML = `${it.parcela.atual}/${it.parcela.total} <span class="bar"><span style="width:${pct}%"></span></span>`;
        meta.appendChild(badge);
      }
      if (it.nota) {
        const notaSpan = document.createElement("span");
        notaSpan.textContent = it.nota;
        meta.appendChild(notaSpan);
      }
      body.appendChild(meta);
    }

    const valor = document.createElement("span");
    if (it.valor === null || it.valor === undefined) {
      valor.className = "item-valor vazio";
      valor.textContent = "definir";
    } else {
      valor.className = "item-valor";
      valor.textContent = money(it.valor);
    }

    li.appendChild(check);
    li.appendChild(body);
    li.appendChild(valor);

    li.addEventListener("click", () => openItemModal(it.id));
    list.appendChild(li);
  }
}

function renderOrcamentos(period) {
  const section = el("orcamentos-section");
  const list = el("orcamentos-list");
  const orcs = computeOrcamentos(period);

  if (orcs.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  list.innerHTML = "";

  for (const o of orcs) {
    const li = document.createElement("li");
    li.className = "orcamento-item" + (o.restante < 0 ? " over" : o.pct >= 80 ? " warn" : "");
    const restanteTxt = o.restante < 0 ? `estourou em ${money(Math.abs(o.restante))}` : `${money(o.restante)} restante`;
    li.innerHTML = `
      <div class="orcamento-top">
        <span class="orcamento-nome">${o.nome}</span>
        <span class="orcamento-valores">${money(o.gasto)} de ${money(o.valor)} · <strong>${restanteTxt}</strong></span>
      </div>
      <div class="orcamento-bar"><span style="width:${o.pct}%"></span></div>`;
    list.appendChild(li);
  }
}

function togglePago(itemId) {
  const period = currentPeriod();
  const it = period.items.find((x) => x.id === itemId);
  if (!it) return;
  it.pago = !it.pago;
  render();
  markDirtyAndSync();
}

/* ===================== Modal: conta ===================== */

function openItemModal(itemId) {
  editingItemId = itemId || null;
  const form = el("form-item");
  form.reset();

  if (itemId) {
    const it = currentPeriod().items.find((x) => x.id === itemId);
    el("item-modal-title").textContent = "Editar conta";
    el("f-nome").value = it.nome;
    el("f-valor").value = it.valor ?? "";
    el("f-parcela-atual").value = it.parcela ? it.parcela.atual : "";
    el("f-parcela-total").value = it.parcela ? it.parcela.total : "";
    el("f-nota").value = it.nota || "";
    el("f-pago").checked = !!it.pago;
    el("f-recorrente").checked = !!it.recorrente;
    el("btn-delete-item").hidden = false;
  } else {
    el("item-modal-title").textContent = "Adicionar conta";
    el("btn-delete-item").hidden = true;
  }
  el("modal-item").hidden = false;
  setTimeout(() => el("f-nome").focus(), 50);
}

function closeItemModal() {
  el("modal-item").hidden = true;
  editingItemId = null;
}

function submitItemForm(ev) {
  ev.preventDefault();
  const nome = el("f-nome").value.trim();
  if (!nome) return;
  const valor = toNum(el("f-valor").value);
  const pAtual = toNum(el("f-parcela-atual").value);
  const pTotal = toNum(el("f-parcela-total").value);
  const nota = el("f-nota").value.trim() || null;
  const pago = el("f-pago").checked;
  const recorrente = el("f-recorrente").checked;
  const parcela = pAtual && pTotal ? { atual: Math.round(pAtual), total: Math.round(pTotal) } : null;

  const period = currentPeriod();

  if (editingItemId) {
    const it = period.items.find((x) => x.id === editingItemId);
    Object.assign(it, { nome, valor, parcela, nota, pago, recorrente });
  } else {
    period.items.push({ id: uid(), nome, valor, parcela, nota, pago, recorrente });
  }

  if (recorrente) {
    upsertRecorrenteFromItem(nome, valor);
  }

  closeItemModal();
  render();
  markDirtyAndSync();
}

function upsertRecorrenteFromItem(nome, valor) {
  const key = nome.trim().toLowerCase();
  const existing = appData.recorrentes.find((r) => r.nome.trim().toLowerCase() === key);
  if (existing) {
    existing.valor = valor ?? existing.valor;
    existing.ativo = true;
  } else {
    appData.recorrentes.push({ id: uid(), nome, valor: valor ?? 0, ativo: true });
  }
}

function deleteCurrentItem() {
  if (!editingItemId) return;
  const period = currentPeriod();
  period.items = period.items.filter((x) => x.id !== editingItemId);
  closeItemModal();
  render();
  markDirtyAndSync();
}

/* ===================== Modal: entrada ===================== */

function openEntradaModal() {
  el("f-entrada-valor").value = currentPeriod().entrada || "";
  el("modal-entrada").hidden = false;
  setTimeout(() => el("f-entrada-valor").focus(), 50);
}

function submitEntradaForm(ev) {
  ev.preventDefault();
  const v = toNum(el("f-entrada-valor").value) || 0;
  currentPeriod().entrada = v;
  el("modal-entrada").hidden = true;
  render();
  markDirtyAndSync();
}

/* ===================== Modal: nova quinzena ===================== */

function openNewPeriodModal() {
  const last = appData.periods[appData.periods.length - 1];
  const next = deriveNextPeriod(last);
  el("np-label").textContent = next.label;
  el("np-entrada").value = last.entrada || "";

  const list = el("np-recorrentes-list");
  list.innerHTML = "";

  const fixas = (appData.recorrentes || []).filter(
    (r) => r.ativo && (r.frequencia !== "mensal" || r.quinzenaMensal === next.quinzena)
  );
  for (const r of fixas) {
    const li = document.createElement("li");
    li.innerHTML = `
      <label style="display:flex;align-items:center;gap:10px;flex:1;cursor:pointer;">
        <input type="checkbox" checked data-kind="fixa" data-ref="${r.id}" style="width:18px;height:18px;accent-color:var(--accent);" />
        <span class="rec-nome">${r.nome}</span>
      </label>
      <span class="rec-valor">${money(r.valor)}</span>`;
    list.appendChild(li);
  }

  const abertas = last.items.filter((it) => it.parcela && it.parcela.atual < it.parcela.total);
  for (const it of abertas) {
    const prox = it.parcela.atual + 1;
    const li = document.createElement("li");
    li.innerHTML = `
      <label style="display:flex;align-items:center;gap:10px;flex:1;cursor:pointer;">
        <input type="checkbox" checked data-kind="parcela" data-ref="${it.id}" style="width:18px;height:18px;accent-color:var(--accent);" />
        <span class="rec-nome">${it.nome} — parcela ${prox}/${it.parcela.total}</span>
      </label>
      <span class="rec-valor">${money(it.valor)}</span>`;
    list.appendChild(li);
  }

  if (fixas.length === 0 && abertas.length === 0) {
    const li = document.createElement("li");
    li.innerHTML = '<span class="hint">Nenhuma conta fixa ou parcela em aberto pra puxar automaticamente.</span>';
    list.appendChild(li);
  }

  el("modal-new-period").hidden = false;
  el("modal-new-period").dataset.lastId = last.id;
}

function confirmNewPeriod() {
  const last = appData.periods.find((p) => p.id === el("modal-new-period").dataset.lastId);
  const next = deriveNextPeriod(last);
  next.entrada = toNum(el("np-entrada").value) || 0;

  const checks = el("np-recorrentes-list").querySelectorAll("input[type=checkbox]:checked");
  checks.forEach((chk) => {
    if (chk.dataset.kind === "fixa") {
      const r = appData.recorrentes.find((x) => x.id === chk.dataset.ref);
      if (r) next.items.push({ id: uid(), nome: r.nome, valor: r.valor, parcela: null, nota: null, pago: false, recorrente: true });
    } else if (chk.dataset.kind === "parcela") {
      const it = last.items.find((x) => x.id === chk.dataset.ref);
      if (it) {
        next.items.push({
          id: uid(),
          nome: it.nome,
          valor: it.valor,
          parcela: { atual: it.parcela.atual + 1, total: it.parcela.total },
          nota: null,
          pago: false,
          recorrente: false,
        });
      }
    }
  });

  appData.periods.push(next);
  currentIndex = appData.periods.length - 1;
  el("modal-new-period").hidden = true;
  render();
  markDirtyAndSync();
  showToast("Quinzena criada!");
}

/* ===================== Modal: configurações ===================== */

function openSettingsModal() {
  el("repo-name-label").textContent = `${sync.REPO_OWNER}/${sync.REPO_NAME}`;
  el("th-repo").textContent = `${sync.REPO_OWNER}/${sync.REPO_NAME}`;
  el("f-token").value = store.getToken();
  updateSyncDetail();
  renderRecorrentesSettings();
  renderOrcamentosSettings();
  el("modal-settings").hidden = false;
}

function updateSyncDetail() {
  const token = store.getToken();
  const detail = el("sync-detail");
  if (!token) {
    detail.textContent = "Sem token configurado — os dados ficam só neste aparelho.";
  } else if (store.isDirty()) {
    detail.textContent = "Há alterações ainda não sincronizadas.";
  } else {
    detail.textContent = "Tudo sincronizado.";
  }
}

async function saveToken() {
  const token = el("f-token").value.trim();
  if (!token) {
    store.setToken("");
    updateSyncDetail();
    showToast("Token removido.");
    return;
  }
  showToast("Verificando token...");
  const ok = await sync.testToken(token);
  if (!ok) {
    showToast("Token inválido ou sem acesso ao repositório. Confira e tente de novo.");
    return;
  }
  store.setToken(token);
  updateSyncDetail();
  showToast("Token salvo! Sincronizando...");
  await doSync();
  updateSyncDetail();
}

function renderRecorrentesSettings() {
  const list = el("settings-recorrentes-list");
  list.innerHTML = "";
  for (const r of appData.recorrentes || []) {
    const li = document.createElement("li");
    li.className = "rec-edit-item";
    li.innerHTML = `
      <div class="rec-edit-top">
        <label style="display:flex;align-items:center;">
          <input type="checkbox" ${r.ativo ? "checked" : ""} data-act="toggle" data-id="${r.id}" style="width:18px;height:18px;margin-right:10px;accent-color:var(--accent);" />
        </label>
        <span class="rec-edit-row">
          <input type="text" class="rec-nome-input" data-act="nome" data-id="${r.id}" value="${r.nome.replace(/"/g, "&quot;")}" />
          <input type="number" step="0.01" class="rec-valor-input" data-act="valor" data-id="${r.id}" value="${r.valor}" />
        </span>
        <button type="button" class="rec-del-btn" data-act="del" data-id="${r.id}" aria-label="Remover">✕</button>
      </div>
      <div class="rec-freq-row">
        <select data-act="freq" data-id="${r.id}">
          <option value="quinzenal" ${r.frequencia !== "mensal" ? "selected" : ""}>Repete a cada quinzena (15 dias)</option>
          <option value="mensal" ${r.frequencia === "mensal" ? "selected" : ""}>Repete 1x por mês (30 dias)</option>
        </select>
        ${
          r.frequencia === "mensal"
            ? `<select data-act="quinzenaMensal" data-id="${r.id}">
                <option value="A" ${r.quinzenaMensal !== "B" ? "selected" : ""}>Na quinzena do dia 05</option>
                <option value="B" ${r.quinzenaMensal === "B" ? "selected" : ""}>Na quinzena do dia 20</option>
              </select>`
            : ""
        }
      </div>`;
    list.appendChild(li);
  }

  list.onchange = (ev) => {
    const { act, id } = ev.target.dataset;
    const r = appData.recorrentes.find((x) => x.id === id);
    if (!r) return;
    if (act === "toggle") r.ativo = ev.target.checked;
    if (act === "nome") r.nome = ev.target.value;
    if (act === "valor") r.valor = toNum(ev.target.value) || 0;
    if (act === "freq") {
      r.frequencia = ev.target.value;
      if (r.frequencia === "mensal" && !r.quinzenaMensal) r.quinzenaMensal = "A";
      renderRecorrentesSettings();
    }
    if (act === "quinzenaMensal") r.quinzenaMensal = ev.target.value;
    markDirtyAndSync();
  };
  list.onclick = (ev) => {
    const btn = ev.target.closest("[data-act='del']");
    if (!btn) return;
    appData.recorrentes = appData.recorrentes.filter((x) => x.id !== btn.dataset.id);
    renderRecorrentesSettings();
    markDirtyAndSync();
  };
}

function addRecorrente() {
  appData.recorrentes.push({ id: uid(), nome: "Nova conta fixa", valor: 0, ativo: true, frequencia: "quinzenal" });
  renderRecorrentesSettings();
  markDirtyAndSync();
}

function renderOrcamentosSettings() {
  const list = el("settings-orcamentos-list");
  list.innerHTML = "";
  for (const o of appData.orcamentos || []) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="rec-edit-row">
        <input type="text" class="rec-nome-input" data-act="nome" data-id="${o.id}" value="${o.nome.replace(/"/g, "&quot;")}" placeholder="Ex: Mercado" />
        <input type="number" step="0.01" class="rec-valor-input" data-act="valor" data-id="${o.id}" value="${o.valor}" placeholder="Reservado" />
      </span>
      <button type="button" class="rec-del-btn" data-act="del" data-id="${o.id}" aria-label="Remover">✕</button>`;
    list.appendChild(li);
  }

  list.onchange = (ev) => {
    const { act, id } = ev.target.dataset;
    const o = appData.orcamentos.find((x) => x.id === id);
    if (!o) return;
    if (act === "nome") o.nome = ev.target.value;
    if (act === "valor") o.valor = toNum(ev.target.value) || 0;
    render();
    markDirtyAndSync();
  };
  list.onclick = (ev) => {
    const btn = ev.target.closest("[data-act='del']");
    if (!btn) return;
    appData.orcamentos = appData.orcamentos.filter((x) => x.id !== btn.dataset.id);
    renderOrcamentosSettings();
    render();
    markDirtyAndSync();
  };
}

function addOrcamento() {
  appData.orcamentos.push({ id: uid(), nome: "", valor: 0 });
  renderOrcamentosSettings();
  markDirtyAndSync();
}

/* ===================== Navegação / seleção de período ===================== */

function openPeriodsModal() {
  if (!periodsModalEl) {
    periodsModalEl = document.createElement("div");
    periodsModalEl.className = "modal-overlay";
    periodsModalEl.innerHTML = `
      <div class="modal-sheet modal-sheet-tall">
        <div class="modal-handle"></div>
        <h2>Quinzenas</h2>
        <ul id="periods-pick-list" class="recorrentes-list"></ul>
        <div class="modal-actions">
          <div class="modal-actions-right">
            <button type="button" id="btn-close-periods" class="btn btn-primary">Fechar</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(periodsModalEl);
    periodsModalEl.addEventListener("click", (ev) => {
      if (ev.target === periodsModalEl) periodsModalEl.hidden = true;
    });
    periodsModalEl.querySelector("#btn-close-periods").addEventListener("click", () => {
      periodsModalEl.hidden = true;
    });
  }

  const list = periodsModalEl.querySelector("#periods-pick-list");
  list.innerHTML = "";
  appData.periods.forEach((p, idx) => {
    const t = periodTotals(p);
    const li = document.createElement("li");
    li.style.cursor = "pointer";
    li.innerHTML = `<span class="rec-nome">${p.label}${idx === currentIndex ? " ·" : ""}</span><span class="rec-valor">${money(t.saldoPrevisto)}</span>`;
    li.addEventListener("click", () => {
      currentIndex = idx;
      periodsModalEl.hidden = true;
      render();
    });
    list.appendChild(li);
  });

  periodsModalEl.hidden = false;
}

/* ===================== Wiring de eventos ===================== */

function wireEvents() {
  el("nav-prev").addEventListener("click", () => {
    if (currentIndex > 0) {
      currentIndex--;
      render();
    }
  });
  el("nav-next").addEventListener("click", () => {
    if (currentIndex < appData.periods.length - 1) {
      currentIndex++;
      render();
    } else {
      openNewPeriodModal();
    }
  });
  el("period-picker").addEventListener("click", openPeriodsModal);

  el("btn-add-item").addEventListener("click", () => openItemModal(null));
  el("form-item").addEventListener("submit", submitItemForm);
  el("btn-cancel-item").addEventListener("click", closeItemModal);
  el("btn-delete-item").addEventListener("click", deleteCurrentItem);

  document.querySelector(".stats-strip .stat:nth-child(1)").addEventListener("click", openEntradaModal);
  el("form-entrada").addEventListener("submit", submitEntradaForm);
  el("btn-cancel-entrada").addEventListener("click", () => (el("modal-entrada").hidden = true));

  el("btn-new-period").addEventListener("click", openNewPeriodModal);
  el("btn-cancel-new-period").addEventListener("click", () => (el("modal-new-period").hidden = true));
  el("btn-confirm-new-period").addEventListener("click", confirmNewPeriod);

  el("btn-settings").addEventListener("click", openSettingsModal);
  el("btn-close-settings").addEventListener("click", () => (el("modal-settings").hidden = true));
  el("btn-save-token").addEventListener("click", saveToken);
  el("btn-sync-now").addEventListener("click", async () => {
    showToast("Sincronizando...");
    await doSync();
    updateSyncDetail();
    showToast(store.isDirty() ? "Não consegui sincronizar." : "Sincronizado!");
  });
  el("btn-add-recorrente").addEventListener("click", addRecorrente);
  el("btn-add-orcamento").addEventListener("click", addOrcamento);

  el("btn-how-token").addEventListener("click", () => (el("modal-token-help").hidden = false));
  el("btn-close-token-help").addEventListener("click", () => (el("modal-token-help").hidden = true));

  // fechar modais clicando fora da folha
  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) overlay.hidden = true;
    });
  });
}

/* ===================== Boot ===================== */

async function boot() {
  await initialLoad();
  clampIndex();
  wireEvents();
  render();

  if (store.isDirty()) {
    setSyncIndicator("pending");
  }

  // tenta sincronizar silenciosamente ao reabrir, se tiver token e nada pendente
  if (store.getToken() && !store.isDirty()) {
    setSyncIndicator("synced");
  }
}

boot();

// registra o service worker simples para funcionar melhor offline (best-effort)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
