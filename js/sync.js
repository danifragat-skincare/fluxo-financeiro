// Sincronização dos dados via GitHub Contents API.
// Lê e escreve o arquivo data.json direto no repositório, para o
// app funcionar igual em qualquer aparelho sem precisar de servidor.

export const REPO_OWNER = "danifragat-skincare";
export const REPO_NAME = "fluxo-financeiro";
export const FILE_PATH = "data.json";
export const BRANCH = "main";

const API_BASE = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`;

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Lê o JSON direto da API do GitHub (sempre fresco, precisa de token). */
export async function fetchRemote(token) {
  const res = await fetch(`${API_BASE}?ref=${BRANCH}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (res.status === 404) {
    return { data: null, sha: null, notFound: true };
  }
  if (!res.ok) {
    const err = new Error(`Erro ao ler do GitHub (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const text = b64ToUtf8(json.content);
  return { data: JSON.parse(text), sha: json.sha };
}

/** Lê o data.json publicado (sem token, pode ter alguns minutos de cache). */
export async function fetchPublic() {
  const res = await fetch("data.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Não foi possível ler data.json");
  return res.json();
}

/** Escreve o JSON no repositório via Contents API (precisa de token com permissão Contents: Read and write). */
export async function pushRemote(token, dataObj, sha) {
  const body = {
    message: `Atualiza dados — ${new Date().toLocaleString("pt-BR")}`,
    content: utf8ToB64(JSON.stringify(dataObj, null, 2)),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await fetch(API_BASE, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errJson = await res.json().catch(() => ({}));
    const err = new Error(errJson.message || `Erro ao salvar no GitHub (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return json.content.sha;
}

/** Testa se o token é válido e tem acesso ao repo. */
export async function testToken(token) {
  const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) return false;
  return true;
}
