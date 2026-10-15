// Cache local (por aparelho) — guarda os dados, o token e o estado
// de sincronização no localStorage do navegador.

const K_DATA = "fluxo_data_v1";
const K_SHA = "fluxo_sha_v1";
const K_TOKEN = "fluxo_token_v1";
const K_DIRTY = "fluxo_dirty_v1";

export function loadLocalData() {
  try {
    const raw = localStorage.getItem(K_DATA);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveLocalData(data) {
  try {
    localStorage.setItem(K_DATA, JSON.stringify(data));
  } catch {
    /* ignore — armazenamento indisponível (modo privado, etc) */
  }
}

export function getSha() {
  try {
    return localStorage.getItem(K_SHA);
  } catch {
    return null;
  }
}

export function setSha(sha) {
  try {
    if (sha) localStorage.setItem(K_SHA, sha);
    else localStorage.removeItem(K_SHA);
  } catch {
    /* ignore */
  }
}

export function getToken() {
  try {
    return localStorage.getItem(K_TOKEN) || "";
  } catch {
    return "";
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(K_TOKEN, token);
    else localStorage.removeItem(K_TOKEN);
  } catch {
    /* ignore */
  }
}

export function isDirty() {
  try {
    return localStorage.getItem(K_DIRTY) === "1";
  } catch {
    return false;
  }
}

export function setDirty(val) {
  try {
    localStorage.setItem(K_DIRTY, val ? "1" : "0");
  } catch {
    /* ignore */
  }
}
