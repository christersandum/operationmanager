// Offline demo: IndexedDB + import/eksport JSON + tre + operasjoner + favoritter
// Denne versjonen inkluderer:
// - Demo-innlogging (URL-parameter ?user=Einar|Nora%20Eide + bruker-velger i toppbar)
// - Einar (admin): full tilgang (dagens oppførsel)
// - Nora Eide (viewer): kun innsyn – ser kun egne operasjoner og medlemmer; kan ikke navigere i avdelingstreet; alle endringsknapper er av
// - Fil-meny (Import/Eksport/Nullstill) i toppbaren (kun admin)
// - "Medlemmer i operasjon": Visning (Liste/Tre) + Sortering (Alfa/Rolle), rolle/fjern side-ved-side (kun admin)
// - Innhold for operasjon: apptype tickboxes (eksklusiv), basemaps tickboxes (multi; alle default),
//   nye tjenester (Skisselag=on, Farlige stoffer/Kritisk infrastruktur/Telekom=off), "Legg til..." i overlay

const DB_NAME = "orgDemoDB";
const DB_VERSION = 7;

const USERS = {
  Einar: { profile: "admin" },
  "Nora Eide": { profile: "viewer" },
};

const ROLES = ["Administrator", "Leder", "Deltaker", "Innsyn"];
const ROLE_ORDER = { "Administrator": 0, "Leder": 1, "Deltaker": 2, "Innsyn": 3 };

const APP_TYPES = ["Generisk", "Overvåkning", "Arrestasjon", "Livvakt", "Hendelseshåndtering"];
const BASEMAPS = ["Gråtone lys", "Gråtone mørk", "Basis", "Basis terreng", "Bilder"];

// Default: alle bakgrunnskart valgt
const DEFAULT_CONTENT = {
  application: true,
  appType: "Generisk",
  map: true,
  basemaps: [...BASEMAPS], // alle valgt som default
  dashboardOverview: false,
  services: {
    blueForceTracking: true,
    redForceTracking: true,
    fotoweb: true,
    milestone: true,
    skisselag: true,             // default på
    poi: true,

    // Ikke default på
    matrikkelEier: false,
    ruteberegning: false,
    farligeStofferLager: false,
    kritiskInfrastruktur: false,
    telekom: false
  }
};

const state = {
  // valg / navigasjon
  selectedDeptId: null,
  selectedEmployeeId: null,
  selectedOperationId: null,

  // høyre panel
  rightTab: "operation", // "operation" | "person"

  // favoritter
  selectedFavoriteNodeId: null,
  viewMode: "dept", // "dept" | "favorite"

  // filtre
  includeChildren: true,
  search: "",

  // tree state
  collapsed: new Set(),
  collapsedInitialized: false,

  // Medlemmer i operasjon - visning/sortering
  operationMembersSort: "alpha",      // "alpha" | "role"
  operationMembersView: "list",       // "list" | "tree"
  opMembersDeptFilterId: null,        // valgt avdeling i trevisning

  // Demo login
  currentUser: "Einar",               // "Einar" | "Nora Eide"
  currentUserProfile: "admin",        // "admin" | "viewer"
  currentUserEmployeeId: null,        // for viewer: hvilken employee brukes som "meg"
  visibleOperationIds: null,          // for viewer: hvilke operasjoner er synlige (Set)
};

const el = (id) => document.getElementById(id);

function setStatus(msg) {
  const s = el("status");
  if (s) s.textContent = msg;
}

function uuid(prefix = "id") {
  return `${prefix}_${crypto.randomUUID()}`;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function isAdmin() {
  return state.currentUserProfile === "admin";
}
function isViewer() {
  return state.currentUserProfile === "viewer";
}

// -------------------- IndexedDB --------------------
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      const upTx = req.transaction;

      if (!db.objectStoreNames.contains("departments")) {
        const dept = db.createObjectStore("departments", { keyPath: "id" });
        dept.createIndex("byParent", "parentId", { unique: false });
        dept.createIndex("byName", "name", { unique: false });
      }

      if (!db.objectStoreNames.contains("employees")) {
        const emp = db.createObjectStore("employees", { keyPath: "id" });
        emp.createIndex("byDept", "deptId", { unique: false });
        emp.createIndex("byName", "name", { unique: false });
      }

      // operations
      if (!db.objectStoreNames.contains("projects")) {
        const proj = db.createObjectStore("projects", { keyPath: "id" });
        proj.createIndex("byName", "name", { unique: false });
      }

      // operationMembers
      if (!db.objectStoreNames.contains("projectMembers")) {
        const mem = db.createObjectStore("projectMembers", { keyPath: "id" });
        mem.createIndex("byProject", "projectId", { unique: false });
        mem.createIndex("byEmployee", "employeeId", { unique: false });
      } else {
        const mem = upTx.objectStore("projectMembers");
        if (!mem.indexNames.contains("byProject")) mem.createIndex("byProject", "projectId", { unique: false });
        if (!mem.indexNames.contains("byEmployee")) mem.createIndex("byEmployee", "employeeId", { unique: false });
      }

      // favorites
      if (!db.objectStoreNames.contains("favoriteNodes")) {
        const fn = db.createObjectStore("favoriteNodes", { keyPath: "id" });
        fn.createIndex("byParent", "parentId", { unique: false });
        fn.createIndex("byName", "name", { unique: false });
      } else {
        const fn = upTx.objectStore("favoriteNodes");
        if (!fn.indexNames.contains("byParent")) fn.createIndex("byParent", "parentId", { unique: false });
        if (!fn.indexNames.contains("byName")) fn.createIndex("byName", "name", { unique: false });
      }

      if (!db.objectStoreNames.contains("favoriteMembers")) {
        const fm = db.createObjectStore("favoriteMembers", { keyPath: "id" });
        fm.createIndex("byNode", "nodeId", { unique: false });
        fm.createIndex("byEmployee", "employeeId", { unique: false });
      } else {
        const fm = upTx.objectStore("favoriteMembers");
        if (!fm.indexNames.contains("byNode")) fm.createIndex("byNode", "nodeId", { unique: false });
        if (!fm.indexNames.contains("byEmployee")) fm.createIndex("byEmployee", "employeeId", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(db, storeName, mode = "readonly") {
  const t = db.transaction(storeName, mode);
  return t.objectStore(storeName);
}

async function getAll(db, storeName) {
  return new Promise(async (resolve, reject) => {
    const store = await tx(db, storeName, "readonly");
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function putMany(db, storeName, items) {
  return new Promise(async (resolve, reject) => {
    const store = await tx(db, storeName, "readwrite");
    let pending = items.length;
    if (pending === 0) return resolve();
    items.forEach((item) => {
      const req = store.put(item);
      req.onsuccess = () => {
        pending--;
        if (pending === 0) resolve();
      };
      req.onerror = () => reject(req.error);
    });
  });
}

async function clearStore(db, storeName) {
  return new Promise(async (resolve, reject) => {
    const store = await tx(db, storeName, "readwrite");
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function deleteKey(db, storeName, key) {
  return new Promise(async (resolve, reject) => {
    const store = await tx(db, storeName, "readwrite");
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function getByIndex(db, storeName, indexName, value) {
  return new Promise(async (resolve, reject) => {
    const store = await tx(db, storeName, "readonly");
    const idx = store.index(indexName);
    const req = idx.getAll(value);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// -------------------- Data helpers --------------------
function buildChildrenMap(nodes) {
  const childrenByParent = new Map();
  for (const n of nodes) {
    const p = n.parentId ?? null;
    if (!childrenByParent.has(p)) childrenByParent.set(p, []);
    childrenByParent.get(p).push(n);
  }
  for (const [, arr] of childrenByParent.entries()) {
    arr.sort((a, b) => (a.name || "").localeCompare(b.name || "", "no"));
  }
  return childrenByParent;
}

function buildParentMap(nodes) {
  const parentById = new Map();
  for (const n of nodes) parentById.set(n.id, n.parentId ?? null);
  return parentById;
}

function expandAncestors(nodeId, parentById) {
  let cur = nodeId;
  while (cur) {
    const parent = parentById.get(cur);
    if (parent) state.collapsed.delete(parent);
    cur = parent;
  }
}

function getPath(nodesById, id) {
  const path = [];
  let cur = nodesById.get(id);
  while (cur) {
    path.push(cur.name);
    cur = cur.parentId ? nodesById.get(cur.parentId) : null;
  }
  return path.reverse().join(" → ");
}

function collectDescendantIds(childrenByParent, rootId) {
  const ids = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    ids.push(id);
    const kids = childrenByParent.get(id) || [];
    for (const k of kids) stack.push(k.id);
  }
  return ids;
}

function collectAncestors(departmentsById, deptId) {
  const out = [];
  let cur = departmentsById.get(deptId);
  while (cur && cur.parentId) {
    out.push(cur.parentId);
    cur = departmentsById.get(cur.parentId);
  }
  return out;
}

function pruneChildrenMapToSet(childrenByParent, allowedSet) {
  const pruned = new Map();
  for (const [p, kids] of childrenByParent.entries()) {
    const kept = (kids || []).filter(k => allowedSet.has(k.id));
    if (kept.length && (p === null || allowedSet.has(p))) pruned.set(p, kept);
  }
  if (!pruned.has(null)) {
    const roots = childrenByParent.get(null)?.filter(r => allowedSet.has(r.id)) || [];
    pruned.set(null, roots);
  }
  return pruned;
}

function initCollapsedDefault(childrenByParent) {
  if (state.collapsedInitialized) return;
  const hasAny = childrenByParent.size > 0;
  if (!hasAny) return;

  for (const [parentId, kids] of childrenByParent.entries()) {
    if (parentId && kids && kids.length) state.collapsed.add(parentId);
  }

  state.collapsed.delete("politiet");
  state.collapsed.delete("politidistrikter");
  state.collapsed.delete("nasjonale-enheter");
  state.collapsed.delete("favoritter");

  state.collapsedInitialized = true;
}

// -------------------- Content model --------------------
function mergeContentDefaults(content) {
  const c = deepClone(DEFAULT_CONTENT);
  if (!content || typeof content !== "object") return c;

  c.application = !!content.application;
  c.appType = APP_TYPES.includes(content.appType) ? content.appType : DEFAULT_CONTENT.appType;

  c.map = !!content.map;

  // Backward compat: tidligere "basemap" (string). Nå "basemaps" (array).
  if (Array.isArray(content.basemaps)) {
    c.basemaps = content.basemaps.filter(b => BASEMAPS.includes(b));
  } else if (typeof content.basemap === "string" && BASEMAPS.includes(content.basemap)) {
    c.basemaps = [content.basemap];
  } else {
    c.basemaps = [...DEFAULT_CONTENT.basemaps];
  }
  if (!c.basemaps.length) c.basemaps = [...DEFAULT_CONTENT.basemaps];

  c.dashboardOverview = !!content.dashboardOverview;

  const s = content.services || {};
  c.services.blueForceTracking = !!s.blueForceTracking;
  c.services.redForceTracking = !!s.redForceTracking;
  c.services.fotoweb = !!s.fotoweb;
  c.services.milestone = !!s.milestone;
  c.services.skisselag = !!s.skisselag;
  c.services.poi = !!s.poi;

  c.services.matrikkelEier = !!s.matrikkelEier;
  c.services.ruteberegning = !!s.ruteberegning;
  c.services.farligeStofferLager = !!s.farligeStofferLager;
  c.services.kritiskInfrastruktur = !!s.kritiskInfrastruktur;
  c.services.telekom = !!s.telekom;

  if (c.application) c.map = true;

  return c;
}

function normalizeOperation(op) {
  const out = { ...op };
  if (!out.status) out.status = "Aktiv";
  out.content = mergeContentDefaults(out.content);
  if (out.content.application) out.content.map = true;
  return out;
}

function contentSummary(content) {
  const c = mergeContentDefaults(content);
  const items = [];

  if (c.application) items.push(`Applikasjon: ${c.appType}`);
  if (c.map) items.push(`Kart: ${c.basemaps.length} valgt`);
  if (c.dashboardOverview) items.push("Dashboard Oversikt");

  const services = [];
  const s = c.services || {};
  if (s.blueForceTracking) services.push("BFT");
  if (s.redForceTracking) services.push("RFT");
  if (s.fotoweb) services.push("Fotoweb");
  if (s.milestone) services.push("Milestone");
  if (s.skisselag) services.push("Skisselag");
  if (s.poi) services.push("POI");
  if (s.matrikkelEier) services.push("Matrikkel");
  if (s.ruteberegning) services.push("Ruteberegning");
  if (s.farligeStofferLager) services.push("Farlige stoffer");
  if (s.kritiskInfrastruktur) services.push("Kritisk infrastruktur");
  if (s.telekom) services.push("Telekom");
  if (services.length) items.push(`Tjenester: ${services.join(", ")}`);

  return items.join(" • ");
}

// -------------------- Favorites helpers --------------------
async function ensureFavoriteRoot() {
  const nodes = await getAll(db, "favoriteNodes");
  if (!nodes.some(n => n.id === "favoritter")) {
    await putMany(db, "favoriteNodes", [{ id: "favoritter", name: "Favoritter", parentId: null, createdAt: new Date().toISOString() }]);
  }
}

async function getFavoriteNodes() {
  await ensureFavoriteRoot();
  return await getAll(db, "favoriteNodes");
}

async function getFavoriteMembers(nodeId) {
  return await getByIndex(db, "favoriteMembers", "byNode", nodeId);
}

async function addEmployeeToFavorite(nodeId, employeeId) {
  const id = `${nodeId}::${employeeId}`;
  await putMany(db, "favoriteMembers", [{ id, nodeId, employeeId, addedAt: new Date().toISOString() }]);
}

async function removeEmployeeFromFavorite(nodeId, employeeId) {
  const id = `${nodeId}::${employeeId}`;
  await deleteKey(db, "favoriteMembers", id);
}

// -------------------- UI inject styles --------------------
function injectStyleOnce() {
  if (document.getElementById("demoExtraStyles")) return;
  const style = document.createElement("style");
  style.id = "demoExtraStyles";
  style.textContent = `
    .row-inline { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:8px; }
    .row-inline .grow { flex:1; min-width:220px; }
    .roleSelect { min-width:170px; }

    .op-content-bar {
      margin: 10px 12px 0;
      padding: 10px 10px;
      border: 1px solid rgba(255,255,255,.10);
      border-radius: 12px;
      background: rgba(0,0,0,.10);
    }
    .op-content-bar .topline {
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      flex-wrap: wrap;
      margin-bottom: 6px;
    }
    .op-content-bar .summary {
      color: rgba(255,255,255,.75);
      font-size: 12px;
      line-height: 1.4;
    }
    dialog.large { width: min(1040px, calc(100vw - 40px)); max-width: 1040px; }
    dialog.large::backdrop { background: rgba(0,0,0,.55); }

    .content-grid { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 10px; }
    .content-card {
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 12px;
      padding: 10px;
      background: rgba(0,0,0,.10);
    }
    .content-card h4 { margin: 0 0 8px 0; font-size: 14px; color: rgba(255,255,255,.90); }
    .content-card label { display:block; margin: 6px 0; color: rgba(255,255,255,.85); font-size: 13px; }
    .content-card .small { margin-top: 4px; }
    .pillRow { display:flex; flex-wrap:wrap; gap:8px; }
    .pill {
      display:flex; align-items:center; gap:6px;
      border: 1px solid rgba(255,255,255,.14);
      background: rgba(0,0,0,.10);
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 13px;
    }
    .pill input { transform: translateY(1px); }

    /* --- Fil-meny --- */
    .file-menu { position: relative; }
    .file-menu > button { min-width: 68px; }
    .file-menu .dropdown {
      position: absolute; top: 100%; left: 0;
      background: rgba(0,0,0,.95);
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 8px;
      padding: 6px;
      display: none;
      min-width: 200px;
      z-index: 9999;
    }
    .file-menu.open .dropdown { display: block; }
    .file-menu .dropdown button {
      width: 100%;
      text-align: left;
      background: transparent;
      border: 0;
      padding: 8px 10px;
    }
    .file-menu .dropdown button:hover { background: rgba(255,255,255,.08); }

    /* --- Høyre panel: verktøylinje for medlemmer --- */
    .members-toolbar {
      display:flex; gap: 10px; align-items:center; flex-wrap: wrap;
      margin: 10px 0;
    }
    .members-toolbar .group { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
    .members-toolbar .seg {
      display:inline-flex; border:1px solid rgba(255,255,255,.14); border-radius: 999px; overflow:hidden;
    }
    .members-toolbar .seg button { background: transparent; border:0; color:inherit; padding:6px 10px; }
    .members-toolbar .seg button.active { background: rgba(255,255,255,.12); }

    /* --- Høyre panel: trevisning for medlemmer --- */
    .op-tree { border:1px solid rgba(255,255,255,.12); border-radius:12px; padding:8px; background: rgba(0,0,0,.08); }
    .op-tree .node { display:flex; gap:6px; align-items:center; padding:4px 6px; border-radius:6px; cursor:pointer; }
    .op-tree .node:hover { background: rgba(255,255,255,.06); }
    .op-tree .node.selected { background: rgba(255,255,255,.12); }
    .op-tree .indent { margin-left: 14px; border-left: 1px dashed rgba(255,255,255,.12); padding-left: 8px; }
    .op-tree .name { flex:1; }
    .op-tree .count { color: rgba(255,255,255,.7); font-size: 12px; }

    /* Skjul gamle knapper hvis de finnes i HTML */
    #btnImport, #btnExport, #btnReset { display:none !important; }
  `;
  document.head.appendChild(style);
}

// -------------------- Login (demo) --------------------
function parseQuery() {
  const out = {};
  const q = location.search.slice(1).split("&").filter(Boolean);
  for (const kv of q) {
    const [k, v] = kv.split("=");
    out[decodeURIComponent(k)] = decodeURIComponent(v || "");
  }
  return out;
}

function setUser(user) {
  const u = USERS[user] ? user : "Einar";
  state.currentUser = u;
  state.currentUserProfile = USERS[u].profile;
  localStorage.setItem("demoUser", u);
  setStatus(`Logget inn som ${u} (${state.currentUserProfile})`);
}

function ensureUserFromUrlOrStorage() {
  const q = parseQuery();
  const fromUrl = q.user && USERS[q.user] ? q.user : null;
  const fromStore = localStorage.getItem("demoUser");
  const chosen = fromUrl || (USERS[fromStore] ? fromStore : "Einar");
  setUser(chosen);

  // Oppdater URL-param (behold andre params)
  if (fromUrl !== chosen) {
    const params = new URLSearchParams(location.search);
    params.set("user", chosen);
    history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
  }
}

function ensureUserSwitcher() {
  const header = document.querySelector("header .toolbar");
  if (!header) return;
  if (header.querySelector("#userSwitcher")) return;

  const wrap = document.createElement("div");
  wrap.id = "userSwitcher";
  wrap.style.display = "inline-flex";
  wrap.style.alignItems = "center";
  wrap.style.gap = "6px";
  wrap.style.marginRight = "8px";

  const label = document.createElement("span");
  label.className = "small";
  label.textContent = "Bruker:";

  const sel = document.createElement("select");
  for (const u of Object.keys(USERS)) {
    const opt = document.createElement("option");
    opt.value = u;
    opt.textContent = u;
    sel.appendChild(opt);
  }
  sel.value = state.currentUser;
  sel.addEventListener("change", async () => {
    setUser(sel.value);
    await refreshAll();
  });

  wrap.appendChild(label);
  wrap.appendChild(sel);
  // legg først i baren
  header.insertBefore(wrap, header.firstChild);
}

async function resolveViewerScope() {
  if (!isViewer()) {
    state.currentUserEmployeeId = null;
    state.visibleOperationIds = null;
    return;
  }
  const [employees, operations, memberships] = await Promise.all([
    getAll(db, "employees"),
    getAll(db, "projects"),
    getAll(db, "projectMembers"),
  ]);

  // Finn en ansatt som heter eksakt "Nora Eide" (case-insensitive)
  const wantedName = "nora eide";
  let emp = employees.find(e => (e.name || "").toLowerCase() === wantedName);

  if (!emp) {
    // Fallback: velg første medlem fra første operasjon
    const firstOp = operations[0];
    const firstMem = firstOp ? memberships.find(m => m.projectId === firstOp.id) : null;
    emp = firstMem ? employees.find(e => e.id === firstMem.employeeId) : employees[0];
    if (emp) setStatus(`Viewer-demo: fant ikke "Nora Eide" i dataene, bruker ${emp.name} som "Nora Eide" i denne økten.`);
  }

  if (!emp) {
    state.currentUserEmployeeId = null;
    state.visibleOperationIds = new Set();
    return;
  }

  state.currentUserEmployeeId = emp.id;

  // Finn alle operasjoner der "Nora Eide" (eller fallback-ansatt) er medlem
  const myMemberships = memberships.filter(m => m.employeeId === emp.id);
  state.visibleOperationIds = new Set(myMemberships.map(m => m.projectId));
}

// -------------------- UI inject: tabs + favorite + file menu --------------------
function ensureRightPanelTabs() {
  const panels = document.querySelectorAll("main.layout .panel");
  const rightPanel = panels?.[2];
  if (!rightPanel) return;

  const h2 = rightPanel.querySelector(".panel-header h2");
  if (h2) h2.textContent = "Operasjoner";

  const controls = rightPanel.querySelector(".panel-header .controls");
  if (!controls) return;

  if (!rightPanel.querySelector("#tabOperation")) {
    const tabWrap = document.createElement("div");
    tabWrap.style.display = "flex";
    tabWrap.style.gap = "8px";
    tabWrap.style.marginTop = "8px";
    tabWrap.style.flexWrap = "wrap";

    const btnA = document.createElement("button");
    btnA.id = "tabOperation";
    btnA.textContent = "Administrer operasjon";

    const btnB = document.createElement("button");
    btnB.id = "tabPersonOps";
    btnB.textContent = "Personens operasjoner";

    btnA.addEventListener("click", () => { state.rightTab = "operation"; refreshAll(); });
    btnB.addEventListener("click", () => { state.rightTab = "person"; refreshAll(); });

    tabWrap.appendChild(btnA);
    tabWrap.appendChild(btnB);
    controls.parentElement.appendChild(tabWrap);
  }
}

function ensureFavoriteButtons() {
  const header = document.querySelector("header .toolbar");
  if (!header) return;

  // Favorittknapper kun for admin
  const shouldHave = isAdmin();
  const exists = header.querySelector("#btnNewFavoriteGroup");
  if (!shouldHave && exists) {
    header.querySelector("#btnNewFavoriteGroup")?.remove();
    header.querySelector("#btnAddToFavorite")?.remove();
    header.querySelector("#btnRemoveFromFavorite")?.remove();
    return;
  }
  if (!shouldHave || exists) return;

  const btnNewFav = document.createElement("button");
  btnNewFav.id = "btnNewFavoriteGroup";
  btnNewFav.textContent = "Ny favorittgruppe";
  btnNewFav.addEventListener("click", createFavoriteGroup);

  const btnAddToFav = document.createElement("button");
  btnAddToFav.id = "btnAddToFavorite";
  btnAddToFav.textContent = "Legg valgt person i favoritt";
  btnAddToFav.addEventListener("click", addSelectedPersonToFavorite);

  const btnRemoveFromFav = document.createElement("button");
  btnRemoveFromFav.id = "btnRemoveFromFavorite";
  btnRemoveFromFav.textContent = "Fjern valgt person fra favoritt";
  btnRemoveFromFav.addEventListener("click", removeSelectedPersonFromCurrentFavorite);

  const anchor = header.firstChild?.nextSibling || header.firstChild;
  header.insertBefore(btnNewFav, anchor);
  header.insertBefore(btnAddToFav, anchor);
  header.insertBefore(btnRemoveFromFav, anchor);
}

function ensureFileMenu() {
  const header = document.querySelector("header .toolbar");
  if (!header) return;

  const exists = header.querySelector("#fileMenu");
  if (!isAdmin()) {
    // fjern meny for viewer
    if (exists) exists.remove();
    return;
  }
  if (exists) return;

  const wrap = document.createElement("div");
  wrap.id = "fileMenu";
  wrap.className = "file-menu";

  const btn = document.createElement("button");
  btn.textContent = "Fil ▾";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    wrap.classList.toggle("open");
  });

  const dd = document.createElement("div");
  dd.className = "dropdown";

  const bImport = document.createElement("button");
  bImport.textContent = "Import JSON…";
  bImport.addEventListener("click", () => {
    wrap.classList.remove("open");
    el("fileInput")?.click();
  });

  const bExport = document.createElement("button");
  bExport.textContent = "Eksport JSON…";
  bExport.addEventListener("click", async () => {
    wrap.classList.remove("open");
    await exportJSON();
  });

  const bReset = document.createElement("button");
  bReset.textContent = "Nullstill…";
  bReset.addEventListener("click", async () => {
    wrap.classList.remove("open");
    if (!confirm("Nullstille alle data i denne demoen?")) return;
    await Promise.all([
      clearStore(db, "departments"),
      clearStore(db, "employees"),
      clearStore(db, "projects"),
      clearStore(db, "projectMembers"),
      clearStore(db, "favoriteNodes"),
      clearStore(db, "favoriteMembers"),
    ]);
    Object.assign(state, {
      selectedDeptId: null,
      selectedEmployeeId: null,
      selectedOperationId: null,
      selectedFavoriteNodeId: null,
      viewMode: "dept",
      rightTab: "operation",
      search: "",
      collapsed: new Set(),
      collapsedInitialized: false,
      operationMembersSort: "alpha",
      operationMembersView: "list",
      opMembersDeptFilterId: null,
    });
    setStatus("Nullstilt");
    refreshAll();
  });

  dd.appendChild(bImport);
  dd.appendChild(bExport);
  dd.appendChild(bReset);

  wrap.appendChild(btn);
  wrap.appendChild(dd);
  header.insertBefore(wrap, header.firstChild);

  document.addEventListener("click", () => wrap.classList.remove("open"));
}

// -------------------- UI rendering main --------------------
async function refreshAll() {
  injectStyleOnce();
  ensureUserSwitcher();

  ensureRightPanelTabs();
  ensureFavoriteButtons();
  ensureFileMenu();

  // Viewer: avklar hvilket employee-id og hvilke operasjoner som er synlige
  await resolveViewerScope();

  const [departments, employees, rawOps, favoriteNodes] = await Promise.all([
    getAll(db, "departments"),
    getAll(db, "employees"),
    getAll(db, "projects"),
    getFavoriteNodes(),
  ]);
  const operations = rawOps.map(normalizeOperation);

  const deptById = new Map(departments.map(d => [d.id, d]));
  const deptChildren = buildChildrenMap(departments);

  const favById = new Map(favoriteNodes.map(n => [n.id, n]));
  const favChildren = buildChildrenMap(favoriteNodes);

  // Admin: injiser favoritter i venstre tre. Viewer: lås tre.
  if (isAdmin()) {
    injectFavoritesIntoDeptTree(deptChildren, favoriteNodes, favChildren);
    initCollapsedDefault(deptChildren);
  }

  renderTree(employees, deptChildren);                  // vil selv håndtere viewer
  renderBreadcrumb(deptById, favById);                  // også her håndteres viewer i praksis

  await renderEmployees(employees, deptChildren, favChildren, operations);
  await renderOperations(operations);

  if (state.rightTab === "operation") {
    await renderOperationContentBar(operations);
    await renderOperationMembers(departments, employees);
  } else {
    await renderSelectedPersonOperations(operations);
  }

  updateActionButtons();
}

function injectFavoritesIntoDeptTree(deptChildren, favoriteNodes, favChildren) {
  const favRoot = { id: "favoritter", name: "Favoritter", parentId: "politiet", _type: "favRoot" };

  const politietKids = deptChildren.get("politiet") || [];
  if (!politietKids.some(x => x.id === "favoritter")) {
    politietKids.push(favRoot);
    politietKids.sort((a, b) => (a.name || "").localeCompare(b.name || "", "no"));
    deptChildren.set("politiet", politietKids);
  }

  const favKids = (favChildren.get("favoritter") || []).map(n => ({ ...n, _type: "favNode" }));
  deptChildren.set("favoritter", favKids);

  for (const n of favoriteNodes) {
    if (n.id === "favoritter") continue;
    const kids = (favChildren.get(n.id) || []).map(k => ({ ...k, _type: "favNode" }));
    if (kids.length) deptChildren.set(n.id, kids);
  }
}

function renderTree(employees, childrenByParent) {
  const treeEl = el("tree");
  if (!treeEl) return;

  // Viewer: lås treet (vis info)
  if (isViewer()) {
    treeEl.innerHTML = `<div class="small">Begrenset innsyn: Navigasjon via avdelinger er deaktivert for denne brukeren.</div>`;
    return;
  }

  treeEl.innerHTML = "";

  const countByDept = new Map();
  for (const e of employees) {
    if (!e.deptId) continue;
    countByDept.set(e.deptId, (countByDept.get(e.deptId) || 0) + 1);
  }

  function renderNode(node, container) {
    const kids = childrenByParent.get(node.id) || [];
    const hasKids = kids.length > 0;
    const isCollapsed = state.collapsed.has(node.id);

    const isFav = !!node._type;
    const isSelectedDept = !isFav && state.selectedDeptId === node.id && state.viewMode === "dept";
    const isSelectedFav = isFav && state.selectedFavoriteNodeId === node.id && state.viewMode === "favorite";

    const row = document.createElement("div");
    row.className = "node" + ((isSelectedDept || isSelectedFav) ? " selected" : "");

    const caret = document.createElement("div");
    caret.className = "caret";
    caret.textContent = hasKids ? (isCollapsed ? "▸" : "▾") : "•";
    if (hasKids) {
      caret.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (state.collapsed.has(node.id)) state.collapsed.delete(node.id);
        else state.collapsed.add(node.id);
        refreshAll();
      });
    }

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = node.name;

    const count = document.createElement("div");
    count.className = "count";
    count.textContent = isFav ? "" : `${countByDept.get(node.id) || 0}`;

    row.appendChild(caret);
    row.appendChild(name);
    row.appendChild(count);

    row.addEventListener("click", async () => {
      if (isFav) {
        state.viewMode = "favorite";
        state.selectedFavoriteNodeId = node.id;
        state.selectedEmployeeId = null;
      } else {
        state.viewMode = "dept";
        state.selectedDeptId = node.id;
        state.selectedEmployeeId = null;
        state.selectedFavoriteNodeId = null;
      }
      await refreshAll();
    });

    row.addEventListener("dblclick", () => {
      if (!hasKids) return;
      if (state.collapsed.has(node.id)) state.collapsed.delete(node.id);
      else state.collapsed.add(node.id);
      refreshAll();
    });

    container.appendChild(row);

    if (hasKids && !isCollapsed) {
      const indent = document.createElement("div");
      indent.className = "indent";
      container.appendChild(indent);
      for (const k of kids) renderNode(k, indent);
    }
  }

  const roots = childrenByParent.get(null) || [];
  if (!roots.length) {
    treeEl.innerHTML = `<div class="small">Ingen avdelinger. Importer data for å fylle treet.</div>`;
    return;
  }

  for (const r of roots) renderNode(r, treeEl);
  const selected = treeEl.querySelector(".node.selected");
  if (selected) selected.scrollIntoView({ block: "nearest" });
}

function renderBreadcrumb(deptById, favById) {
  const bc = el("deptBreadcrumb");
  if (!bc) return;

  if (isViewer()) {
    bc.textContent = `Begrenset innsyn (${state.currentUser})`;
    return;
  }

  if (state.viewMode === "favorite") {
    if (!state.selectedFavoriteNodeId) {
      bc.textContent = "Favoritter";
      return;
    }
    bc.textContent = getPath(favById, state.selectedFavoriteNodeId);
    return;
  }

  if (!state.selectedDeptId) {
    bc.textContent = "Ingen avdeling valgt";
    return;
  }

  bc.textContent = getPath(deptById, state.selectedDeptId);
}

async function renderEmployees(employees, deptChildren, favChildren, operations) {
  const listEl = el("employeeList");
  if (!listEl) return;
  listEl.innerHTML = "";

  let filtered = [];

  if (isViewer()) {
    // Union av alle medlemmer i viewerens operasjoner
    const memberships = await getAll(db, "projectMembers");
    const myOps = state.visibleOperationIds || new Set();
    const allowedEmpIds = new Set(
      memberships
        .filter(m => myOps.has(m.projectId))
        .map(m => m.employeeId)
    );
    filtered = employees.filter(e => allowedEmpIds.has(e.id));
  } else if (state.viewMode === "favorite") {
    if (!state.selectedFavoriteNodeId) {
      listEl.innerHTML = `<div class="small">Velg "Favoritter" i treet, og deretter en gruppe.</div>`;
      return;
    }

    const subgroups = (favChildren.get(state.selectedFavoriteNodeId) || []).filter(n => n.id !== "favoritter");
    if (subgroups.length) {
      const hdr = document.createElement("div");
      hdr.className = "small";
      hdr.style.marginBottom = "8px";
      hdr.textContent = "Undergrupper";
      listEl.appendChild(hdr);

      for (const g of subgroups) {
        const item = document.createElement("div");
        item.className = "item";
        item.style.cursor = "pointer";

        const title = document.createElement("div");
        title.className = "title";
        title.textContent = `📁 ${g.name}`;

        const meta = document.createElement("div");
        meta.className = "meta";
        meta.innerHTML = `<span>Klikk for å åpne</span>`;

        item.appendChild(title);
        item.appendChild(meta);
        item.addEventListener("click", async () => {
          state.viewMode = "favorite";
          state.selectedFavoriteNodeId = g.id;
          state.collapsed.delete("favoritter");
          state.collapsed.delete(g.id);
          await refreshAll();
        });

        listEl.appendChild(item);
      }

      const sep = document.createElement("div");
      sep.className = "small";
      sep.style.margin = "10px 0 8px";
      sep.textContent = "Personer";
      listEl.appendChild(sep);
    }

    if (state.selectedFavoriteNodeId === "favoritter") {
      if (!subgroups.length) {
        listEl.innerHTML = `<div class="small">Ingen favorittgrupper. Klikk "Ny favorittgruppe" for å lage en.</div>`;
      }
      return;
    }

    const members = await getFavoriteMembers(state.selectedFavoriteNodeId);
    const memberIds = new Set(members.map(m => m.employeeId));
    filtered = employees.filter(e => memberIds.has(e.id));
  } else {
    if (!state.selectedDeptId) {
      listEl.innerHTML = `<div class="small">Velg en avdeling i treet.</div>`;
      return;
    }
    const deptIds = state.includeChildren
      ? collectDescendantIds(deptChildren, state.selectedDeptId)
      : [state.selectedDeptId];

    const deptSet = new Set(deptIds);
    filtered = employees.filter(e => deptSet.has(e.deptId));
  }

  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    filtered = filtered.filter(e => (e.name || "").toLowerCase().includes(q));
  }

  filtered.sort((a, b) => (a.name || "").localeCompare(b.name || "", "no"));

  if (!filtered.length) {
    listEl.innerHTML = `<div class="small">Ingen personer matcher filteret.</div>`;
    return;
  }

  renderEmployeeItems(listEl, filtered);
}

function renderEmployeeItems(listEl, employees) {
  const MAX = 200;
  const shown = employees.slice(0, MAX);

  for (const e of shown) {
    const item = document.createElement("div");
    item.className = "item" + (state.selectedEmployeeId === e.id ? " selected" : "");

    item.addEventListener("click", async () => {
      state.selectedEmployeeId = e.id;

      if (isAdmin()) {
        const deps = await getAll(db, "departments");
        const parentById = buildParentMap(deps);
        state.selectedDeptId = e.deptId;
        expandAncestors(e.deptId, parentById);
      }
      await refreshAll();
    });

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = e.name;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<span>${e.title ? e.title : "—"}</span><span>ID: ${e.id}</span>`;

    item.appendChild(title);
    item.appendChild(meta);
    listEl.appendChild(item);
  }

  if (employees.length > MAX) {
    const note = document.createElement("div");
    note.className = "small";
    note.textContent = `Viser ${MAX} av ${employees.length} treff. Avgrens med søk.`;
    listEl.appendChild(note);
  }
}

async function renderOperations(operations) {
  const sel = el("projectSelect");
  if (!sel) return;
  sel.innerHTML = "";

  const info = el("projectInfo");

  // Viewer: filtrer operasjoner til kun egne
  let visibleOps = operations;
  if (isViewer()) {
    const allowed = state.visibleOperationIds || new Set();
    visibleOps = operations.filter(o => allowed.has(o.id));
  }

  if (!visibleOps.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Ingen operasjoner";
    sel.appendChild(opt);
    state.selectedOperationId = null;
    if (info) info.textContent = isViewer()
      ? "Ingen operasjoner tilknyttet din bruker i demoen."
      : "Opprett en operasjon for å legge til medlemmer.";
    return;
  }

  visibleOps.sort((a, b) => (a.name || "").localeCompare(b.name || "", "no"));

  for (const op of visibleOps) {
    const opt = document.createElement("option");
    opt.value = op.id;
    opt.textContent = op.name;
    sel.appendChild(opt);
  }

  if (!state.selectedOperationId || !visibleOps.some(o => o.id === state.selectedOperationId)) {
    state.selectedOperationId = visibleOps[0].id;
  }

  sel.value = state.selectedOperationId;

  const current = visibleOps.find(o => o.id === state.selectedOperationId);
  if (info) {
    const summary = current?.content ? contentSummary(current.content) : "";
    info.textContent = current
      ? `${current.name} (${current.status || "—"})` + (summary ? ` — ${summary}` : "")
      : "Velg en operasjon";
  }
}

// -------------------- Inline controls: Role UI --------------------
function roleSelect(selected) {
  const s = selected || "Deltaker";
  const select = document.createElement("select");
  select.className = "roleSelect";
  for (const r of ROLES) {
    const o = document.createElement("option");
    o.value = r;
    o.textContent = r;
    if (r === s) o.selected = true;
    select.appendChild(o);
  }
  return select;
}

async function updateMemberRole(operationId, employeeId, newRole) {
  const id = `${operationId}::${employeeId}`;
  const members = await getByIndex(db, "projectMembers", "byProject", operationId);
  const existing = members.find(m => m.id === id);
  const payload = existing ? { ...existing, role: newRole } : {
    id,
    projectId: operationId,
    employeeId,
    addedAt: new Date().toISOString(),
    role: newRole
  };
  await putMany(db, "projectMembers", [payload]);
}

// -------------------- Operation content bar (integrated) --------------------
async function renderOperationContentBar(operations) {
  const panels = document.querySelectorAll("main.layout .panel");
  const rightPanel = panels?.[2];
  if (!rightPanel) return;

  const actions = rightPanel.querySelector(".actions");
  if (!actions) return;

  let bar = rightPanel.querySelector("#opContentBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "opContentBar";
    bar.className = "op-content-bar";
    actions.insertAdjacentElement("afterend", bar);
  }

  if (!state.selectedOperationId) {
    bar.innerHTML = `<div class="small">Velg en operasjon for å se/redigere innhold.</div>`;
    return;
  }

  const current = operations.find(o => o.id === state.selectedOperationId);
  if (!current) {
    bar.innerHTML = `<div class="small">Operasjon ikke funnet.</div>`;
    return;
  }

  const summary = contentSummary(current.content);

  bar.innerHTML = `
    <div class="topline">
      <div style="font-weight:650;">Innhold (fake ArcGIS Enterprise)</div>
      ${isAdmin() ? `<button id="btnEditOpContent">Rediger</button>` : ``}
    </div>
    <div class="summary">${summary || "Ingen innhold valgt."}</div>
  `;

  if (isAdmin()) {
    bar.querySelector("#btnEditOpContent")?.addEventListener("click", () => editOperationContent(current));
  }
}

// -------------------- Operation members (list / tree) --------------------
async function renderOperationMembers(departments, employees) {
  const list = el("projectMembers");
  if (!list) return;

  const panels = document.querySelectorAll("main.layout .panel");
  const rightPanel = panels?.[2];
  const sub = rightPanel?.querySelector(".subheader");
  if (sub) sub.textContent = "Medlemmer i operasjon";

  list.innerHTML = "";

  if (!state.selectedOperationId) {
    list.innerHTML = `<div class="small">Velg en operasjon.</div>`;
    return;
  }

  const memberships = await getByIndex(db, "projectMembers", "byProject", state.selectedOperationId);
  if (!memberships.length) {
    list.innerHTML = `<div class="small">Ingen medlemmer i operasjonen enda.</div>`;
    return;
  }

  // Toolbar: Visning & Sortering (vises også for viewer, men sort påvirker kun visning)
  const toolbar = document.createElement("div");
  toolbar.className = "members-toolbar";

  // Visning: Liste | Tre
  const viewGroup = document.createElement("div");
  viewGroup.className = "group";
  viewGroup.innerHTML = `<span class="small">Visning:</span>`;
  const viewSeg = document.createElement("div"); viewSeg.className = "seg";
  const btnList = document.createElement("button"); btnList.textContent = "Liste";
  const btnTree = document.createElement("button"); btnTree.textContent = "Tre";
  const applyViewActive = () => {
    btnList.classList.toggle("active", state.operationMembersView === "list");
    btnTree.classList.toggle("active", state.operationMembersView === "tree");
  };
  btnList.addEventListener("click", () => { state.operationMembersView = "list"; state.opMembersDeptFilterId = null; refreshAll(); });
  btnTree.addEventListener("click", () => { state.operationMembersView = "tree"; refreshAll(); });
  viewSeg.append(btnList, btnTree);
  viewGroup.append(viewSeg);

  // Sortering: Alfa | Rolle
  const sortGroup = document.createElement("div");
  sortGroup.className = "group";
  sortGroup.innerHTML = `<span class="small">Sorter:</span>`;
  const sortSeg = document.createElement("div"); sortSeg.className = "seg";
  const btnAlpha = document.createElement("button"); btnAlpha.textContent = "Alfabetisk";
  const btnRole = document.createElement("button"); btnRole.textContent = "Rolle";
  const applySortActive = () => {
    btnAlpha.classList.toggle("active", state.operationMembersSort === "alpha");
    btnRole.classList.toggle("active", state.operationMembersSort === "role");
  };
  btnAlpha.addEventListener("click", () => { state.operationMembersSort = "alpha"; refreshAll(); });
  btnRole.addEventListener("click", () => { state.operationMembersSort = "role"; refreshAll(); });
  sortSeg.append(btnAlpha, btnRole);
  sortGroup.append(sortSeg);

  toolbar.append(viewGroup, sortGroup);
  list.prepend(toolbar);
  applyViewActive(); applySortActive();

  if (state.operationMembersView === "tree") {
    await renderOperationMembersTree(departments, employees, memberships);
    return;
  }

  const empById = new Map(employees.map(e => [e.id, e]));
  const rows = memberships.map(m => ({ m, e: empById.get(m.employeeId) })).filter(x => x.e);

  // Sortering
  if (state.operationMembersSort === "role") {
    rows.sort((a, b) => {
      const ra = ROLE_ORDER[a.m.role || "Deltaker"] ?? 99;
      const rb = ROLE_ORDER[b.m.role || "Deltaker"] ?? 99;
      if (ra !== rb) return ra - rb;
      return (a.e.name || "").localeCompare(b.e.name || "", "no");
    });
  } else {
    rows.sort((a, b) => (a.e.name || "").localeCompare(b.e.name || "", "no"));
  }

  for (const r of rows) {
    const item = document.createElement("div");
    item.className = "item";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = r.e.name;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<span>${r.e.title || "—"}</span><span>lagt til: ${new Date(r.m.addedAt).toLocaleString("no-NO")}</span>`;

    const row = document.createElement("div");
    row.className = "row-inline";

    const roleBox = document.createElement("div");
    roleBox.className = "grow";
    roleBox.innerHTML = `<div class="small">Rolle</div>`;

    if (isAdmin()) {
      const select = roleSelect(r.m.role || "Deltaker");
      select.addEventListener("change", async (ev) => {
        await updateMemberRole(state.selectedOperationId, r.e.id, ev.target.value);
        setStatus("Rolle oppdatert");
        refreshAll();
      });
      roleBox.appendChild(select);
    } else {
      const text = document.createElement("div");
      text.className = "small";
      text.textContent = r.m.role || "Deltaker";
      roleBox.appendChild(text);
    }

    const btn = document.createElement("button");
    btn.textContent = "Fjern";
    btn.disabled = !isAdmin();
    btn.addEventListener("click", async () => {
      if (!isAdmin()) return;
      await deleteKey(db, "projectMembers", r.m.id);
      setStatus("Fjernet fra operasjon");
      refreshAll();
    });

    row.appendChild(roleBox);
    row.appendChild(btn);

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(row);
    list.appendChild(item);
  }
}

// -------------------- Operation members: Tree view --------------------
async function renderOperationMembersTree(departments, employees, memberships) {
  const list = el("projectMembers");
  if (!list) return;

  const depById = new Map(departments.map(d => [d.id, d]));
  const childrenByParent = buildChildrenMap(departments);

  const empById = new Map(employees.map(e => [e.id, e]));
  const memberEmps = memberships.map(m => empById.get(m.employeeId)).filter(Boolean);

  const deptsWithMembers = new Set(memberEmps.map(e => e.deptId));
  for (const d of [...deptsWithMembers]) {
    for (const anc of collectAncestors(depById, d)) deptsWithMembers.add(anc);
  }

  const prunedChildren = pruneChildrenMapToSet(childrenByParent, deptsWithMembers);

  const treeWrap = document.createElement("div");
  treeWrap.className = "op-tree";
  list.appendChild(treeWrap);

  const countDirect = new Map();
  for (const e of memberEmps) {
    countDirect.set(e.deptId, (countDirect.get(e.deptId) || 0) + 1);
  }

  function renderNode(node, container) {
    const kids = prunedChildren.get(node.id) || [];
    the_hasKids = kids.length > 0;

    const row = document.createElement("div");
    row.className = "node" + (state.opMembersDeptFilterId === node.id ? " selected" : "");

    const caret = document.createElement("div");
    caret.textContent = the_hasKids ? "▾" : "•";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = node.name;

    const cnt = document.createElement("div");
    cnt.className = "count";
    cnt.textContent = `${countDirect.get(node.id) || 0}`;

    row.append(caret, name, cnt);
    row.addEventListener("click", () => {
      state.opMembersDeptFilterId = node.id;
      refreshAll();
    });

    container.appendChild(row);
    if (the_hasKids) {
      const indent = document.createElement("div");
      indent.className = "indent";
      container.appendChild(indent);
      for (const k of kids) renderNode(k, indent);
    }
  }

  const roots = prunedChildren.get(null) || [];
  for (const r of roots) renderNode(r, treeWrap);

  const membershipByEmpId = new Map(memberships.map(m => [m.employeeId, m]));

  let filteredRows = [];
  if (state.opMembersDeptFilterId) {
    const descIds = collectDescendantIds(childrenByParent, state.opMembersDeptFilterId);
    const allowed = new Set(descIds);
    const filteredEmps = memberEmps.filter(e => allowed.has(e.deptId));
    filteredRows = filteredEmps.map(e => ({ e, m: membershipByEmpId.get(e.id) })).filter(x => x.m);
  } else {
    filteredRows = memberEmps.map(e => ({ e, m: membershipByEmpId.get(e.id) })).filter(x => x.m);
  }

  if (state.operationMembersSort === "role") {
    filteredRows.sort((a, b) => {
      const ra = ROLE_ORDER[a.m.role || "Deltaker"] ?? 99;
      const rb = ROLE_ORDER[b.m.role || "Deltaker"] ?? 99;
      if (ra !== rb) return ra - rb;
      return (a.e.name || "").localeCompare(b.e.name || "", "no");
    });
  } else {
    filteredRows.sort((a, b) => (a.e.name || "").localeCompare(b.e.name || "", "no"));
  }

  if (!filteredRows.length) {
    const note = document.createElement("div");
    note.className = "small";
    note.style.marginTop = "8px";
    note.textContent = "Ingen medlemmer i denne grenen.";
    list.appendChild(note);
    return;
  }

  for (const r of filteredRows) {
    const item = document.createElement("div");
    item.className = "item";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = r.e.name;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<span>${r.e.title || "—"}</span><span>rolle: ${r.m.role || "Deltaker"}</span>`;

    const row = document.createElement("div");
    row.className = "row-inline";

    const roleBox = document.createElement("div");
    roleBox.className = "grow";
    roleBox.innerHTML = `<div class="small">Rolle</div>`;

    if (isAdmin()) {
      const select = roleSelect(r.m.role || "Deltaker");
      select.addEventListener("change", async (ev) => {
        await updateMemberRole(r.m.projectId || state.selectedOperationId, r.e.id, ev.target.value);
        setStatus("Rolle oppdatert");
        refreshAll();
      });
      roleBox.appendChild(select);
    } else {
      const text = document.createElement("div");
      text.className = "small";
      text.textContent = r.m.role || "Deltaker";
      roleBox.appendChild(text);
    }

    const btn = document.createElement("button");
    btn.textContent = "Fjern";
    btn.disabled = !isAdmin();
    btn.addEventListener("click", async () => {
      if (!isAdmin()) return;
      await deleteKey(db, "projectMembers", r.m.id);
      setStatus("Fjernet fra operasjon");
      refreshAll();
    });

    row.append(roleBox, btn);

    item.append(title, meta, row);
    list.appendChild(item);
  }
}

// -------------------- Personens operasjoner --------------------
async function renderSelectedPersonOperations(operations) {
  const list = el("projectMembers");
  if (!list) return;

  const panels = document.querySelectorAll("main.layout .panel");
  const rightPanel = panels?.[2];
  const sub = rightPanel?.querySelector(".subheader");
  if (sub) sub.textContent = "Operasjoner for valgt person";

  list.innerHTML = "";

  if (!state.selectedEmployeeId) {
    list.innerHTML = `<div class="small">Velg en person for å se hvilke operasjoner vedkommende er medlem av.</div>`;
    return;
  }

  const memberships = await getByIndex(db, "projectMembers", "byEmployee", state.selectedEmployeeId);
  if (!memberships.length) {
    list.innerHTML = `<div class="small">Personen er ikke medlem av noen operasjoner.</div>`;
    return;
  }

  // Viewer: begrens til egne operasjoner
  let rowsOps = operations;
  if (isViewer()) {
    const allowed = state.visibleOperationIds || new Set();
    rowsOps = operations.filter(o => allowed.has(o.id));
  }

  const opById = new Map(rowsOps.map(o => [o.id, o]));
  const rows = memberships
    .map(m => ({ m, op: opById.get(m.projectId) }))
    .filter(x => x.op);

  rows.sort((a, b) => (a.op.name || "").localeCompare(b.op.name || "", "no"));

  if (!rows.length) {
    list.innerHTML = `<div class="small">Ingen operasjoner synlige for denne brukeren.</div>`;
    return;
  }

  for (const r of rows) {
    const item = document.createElement("div");
    item.className = "item";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = r.op.name;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<span>Status: ${r.op.status || "—"}</span><span>lagt til: ${new Date(r.m.addedAt).toLocaleString("no-NO")}</span>`;

    const row = document.createElement("div");
    row.className = "row-inline";

    const roleBox = document.createElement("div");
    roleBox.className = "grow";
    roleBox.innerHTML = `<div class="small">Rolle</div>`;

    if (isAdmin()) {
      const select = roleSelect(r.m.role || "Deltaker");
      select.addEventListener("change", async (ev) => {
        await updateMemberRole(r.m.projectId, state.selectedEmployeeId, ev.target.value);
        setStatus("Rolle oppdatert");
        refreshAll();
      });
      roleBox.appendChild(select);
    } else {
      const text = document.createElement("div");
      text.className = "small";
      text.textContent = r.m.role || "Deltaker";
      roleBox.appendChild(text);
    }

    const btn = document.createElement("button");
    btn.textContent = "Fjern";
    btn.disabled = !isAdmin();
    btn.addEventListener("click", async () => {
      if (!isAdmin()) return;
      await deleteKey(db, "projectMembers", r.m.id);
      setStatus("Fjernet personen fra operasjon");
      refreshAll();
    });

    row.appendChild(roleBox);
    row.appendChild(btn);

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(row);
    list.appendChild(item);
  }
}

// -------------------- Actions: add members --------------------
async function addEmployeeToOperation(operationId, employeeId, role = "Deltaker") {
  if (!isAdmin()) return;
  const id = `${operationId}::${employeeId}`;
  await putMany(db, "projectMembers", [{
    id,
    projectId: operationId,
    employeeId,
    addedAt: new Date().toISOString(),
    role
  }]);
}

async function addAllFromSelectedScopeToOperation() {
  if (!isAdmin()) return;
  if (!state.selectedOperationId) return;

  if (state.viewMode === "favorite") {
    const nodeId = state.selectedFavoriteNodeId;
    if (!nodeId || nodeId === "favoritter") return;

    const members = await getFavoriteMembers(nodeId);
    const ids = members.map(m => m.employeeId);
    const existing = await getByIndex(db, "projectMembers", "byProject", state.selectedOperationId);
    const existingSet = new Set(existing.map(m => m.employeeId));
    const toAdd = ids.filter(id => !existingSet.has(id)).map(eid => ({
      id: `${state.selectedOperationId}::${eid}`,
      projectId: state.selectedOperationId,
      employeeId: eid,
      addedAt: new Date().toISOString(),
      role: "Deltaker"
    }));
    await putMany(db, "projectMembers", toAdd);
    setStatus(`La til ${toAdd.length} personer fra favorittgruppe (engangskopi)`);
    refreshAll();
    return;
  }

  if (!state.selectedDeptId) return;
  const [departments, employees] = await Promise.all([getAll(db, "departments"), getAll(db, "employees")]);
  const children = buildChildrenMap(departments);
  const deptIds = collectDescendantIds(children, state.selectedDeptId);
  const deptSet = new Set(deptIds);
  const candidates = employees.filter(e => deptSet.has(e.deptId));

  const existing = await getByIndex(db, "projectMembers", "byProject", state.selectedOperationId);
  const existingSet = new Set(existing.map(m => m.employeeId));

  const toAdd = candidates
    .filter(e => !existingSet.has(e.id))
    .map(e => ({
      id: `${state.selectedOperationId}::${e.id}`,
      projectId: state.selectedOperationId,
      employeeId: e.id,
      addedAt: new Date().toISOString(),
      role: "Deltaker"
    }));

  await putMany(db, "projectMembers", toAdd);
  setStatus(`La til ${toAdd.length} personer fra avdeling (engangskopi)`);
  refreshAll();
}

// -------------------- Modal helpers --------------------
function showModal(title, bodyHtml, onOk, opts = {}) {
  const modal = el("modal");
  if (!modal) return;

  modal.classList.toggle("large", !!opts.large);

  el("modalTitle").textContent = title;
  el("modalBody").innerHTML = bodyHtml;

  modal.showModal();

  const form = el("modalForm");
  const okBtn = el("modalOk");

  const handler = async (e) => {
    const isOk = e.submitter === okBtn;
    if (isOk) {
      e.preventDefault();
      try {
        await onOk(new FormData(form));
        modal.close();
        modal.classList.remove("large");
      } catch (err) {
        alert(err?.message || String(err));
      }
    }
  };

  form.addEventListener("submit", handler, { once: true });
  if (opts.onOpen) opts.onOpen();
}

// Overlay-modal for "Legg til..." (åpnes over eksisterende modal)
function showOverlayModal(title, bodyHtml, opts = {}) {
  const dlg = document.createElement("dialog");
  dlg.className = opts.large ? "large" : "";
  dlg.style.border = "1px solid rgba(255,255,255,.12)";
  dlg.style.borderRadius = "14px";
  dlg.style.padding = "0";
  dlg.style.background = "rgba(17, 27, 46, .97)";
  dlg.style.color = "var(--text)";
  dlg.style.maxWidth = opts.large ? "980px" : "560px";

  const content = document.createElement("div");
  content.style.padding = "14px";
  content.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
      <h3 style="margin:0;font-size:16px;">${title}</h3>
      <button id="overlayCloseBtn" style="padding:6px 10px;">Lukk</button>
    </div>
    <div style="margin-top:10px;">${bodyHtml}</div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">
      <button id="overlayCancelBtn">Avbryt</button>
    </div>
  `;

  dlg.appendChild(content);
  document.body.appendChild(dlg);

  const cleanup = () => {
    try { dlg.close(); } catch {}
    dlg.remove();
  };

  content.querySelector("#overlayCloseBtn")?.addEventListener("click", cleanup);
  content.querySelector("#overlayCancelBtn")?.addEventListener("click", cleanup);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); cleanup(); });

  dlg.showModal();
  if (opts.onOpen) opts.onOpen(dlg, content, cleanup);
  return { dlg, content, close: cleanup };
}

// -------------------- Innhold editor --------------------
function appTypePillsHtml(selected) {
  const sel = APP_TYPES.includes(selected) ? selected : DEFAULT_CONTENT.appType;
  return `
    <div class="pillRow">
      ${APP_TYPES.map(t => `
        <label class="pill">
          <input type="checkbox" name="apptype" value="${t}" ${t === sel ? "checked" : ""}>
          ${t}
        </label>
      `).join("")}
    </div>
  `;
}

function basemapPillsHtml(selectedBasemaps) {
  const selected = Array.isArray(selectedBasemaps) ? selectedBasemaps : [...DEFAULT_CONTENT.basemaps];
  const set = new Set(selected.filter(b => BASEMAPS.includes(b)));
  return `
    <div class="pillRow">
      ${BASEMAPS.map(b => `
        <label class="pill">
          <input type="checkbox" name="basemap" value="${b}" ${set.has(b) ? "checked" : ""}>
          ${b}
        </label>
      `).join("")}
    </div>
    <div class="small">Alle bakgrunnskart er valgt som default.</div>
  `;
}

function contentEditorHtml(content) {
  const c = mergeContentDefaults(content);
  return `
    <div class="small">Fake ArcGIS Enterprise: velg innhold for operasjonen.</div>

    <div class="content-grid">
      <div class="content-card">
        <h4>Applikasjon</h4>
        <label><input type="checkbox" name="content_application" ${c.application ? "checked" : ""}> Applikasjon</label>
        <div class="small">Applikasjonstype (kun én kan være valgt):</div>
        ${appTypePillsHtml(c.appType)}
        <div class="small">Hvis Applikasjon er valgt, blir Kart automatisk valgt.</div>
      </div>

      <div class="content-card">
        <h4>Kart</h4>
        <label><input type="checkbox" name="content_map" ${c.map ? "checked" : ""}> Kart</label>
        <div class="small">Bakgrunnskart (flere kan velges):</div>
        ${basemapPillsHtml(c.basemaps)}
      </div>

      <div class="content-card">
        <h4>Dashboard</h4>
        <label><input type="checkbox" name="content_dashboard" ${c.dashboardOverview ? "checked" : ""}> Dashboard Oversikt</label>
      </div>

      <div class="content-card">
        <h4>Tjenester</h4>

        <label><input type="checkbox" name="svc_bft" ${c.services.blueForceTracking ? "checked" : ""}> Blue force tracking</label>
        <label><input type="checkbox" name="svc_rft" ${c.services.redForceTracking ? "checked" : ""}> Red force tracking</label>
        <label><input type="checkbox" name="svc_fotoweb" ${c.services.fotoweb ? "checked" : ""}> Fotoweb</label>
        <label><input type="checkbox" name="svc_milestone" ${c.services.milestone ? "checked" : ""}> Milestone</label>
        <label style="margin-left:14px;"><input type="checkbox" name="svc_skisselag" ${c.services.skisselag ? "checked" : ""}> Skisselag</label>
        <label><input type="checkbox" name="svc_poi" ${c.services.poi ? "checked" : ""}> POI</label>

        <hr style="opacity:.25;margin:10px 0;" />

        <label><input type="checkbox" name="svc_matrikkel" ${c.services.matrikkelEier ? "checked" : ""}> Matrikkel Eier</label>
        <label><input type="checkbox" name="svc_rute" ${c.services.ruteberegning ? "checked" : ""}> Ruteberegning</label>

        <label><input type="checkbox" name="svc_farlige" ${c.services.farligeStofferLager ? "checked" : ""}> Farlige Stoffer (Lager)</label>
        <label><input type="checkbox" name="svc_kritisk" ${c.services.kritiskInfrastruktur ? "checked" : ""}> Kritisk Infrastruktur</label>
        <label><input type="checkbox" name="svc_telekom" ${c.services.telekom ? "checked" : ""}> Telekom</label>

        <div style="margin-top:10px;">
          ${isAdmin() ? `<button type="button" id="btnAddService">Legg til…</button>` : ``}
          <div class="small">Legg til ekstra lag (fake ArcGIS).</div>
        </div>
      </div>
    </div>
  `;
}

function enforceExclusiveCheckboxGroup(name, containerSelector = "#modalBody") {
  const inputs = Array.from(document.querySelectorAll(`${containerSelector} input[name="${name}"]`));
  inputs.forEach(inp => {
    inp.addEventListener("change", () => {
      if (inp.checked) {
        inputs.forEach(other => { if (other !== inp) other.checked = false; });
      } else {
        if (!inputs.some(x => x.checked)) {
          const def = inputs.find(x => x.value === DEFAULT_CONTENT.appType);
          if (def) def.checked = true;
        }
      }
    });
  });
}

function readContentFromForm(fd) {
  const application = fd.get("content_application") === "on";
  let map = fd.get("content_map") === "on";
  const dashboardOverview = fd.get("content_dashboard") === "on";

  const appTypeChecked = Array.from(document.querySelectorAll(`#modalBody input[name="apptype"]`))
    .find(x => x.checked)?.value;
  const appType = APP_TYPES.includes(appTypeChecked) ? appTypeChecked : DEFAULT_CONTENT.appType;

  const basemaps = Array.from(document.querySelectorAll(`#modalBody input[name="basemap"]`))
    .filter(x => x.checked)
    .map(x => x.value)
    .filter(b => BASEMAPS.includes(b));

  if (application) map = true;

  return mergeContentDefaults({
    application,
    appType,
    map,
    basemaps: basemaps.length ? basemaps : [...DEFAULT_CONTENT.basemaps],
    dashboardOverview,
    services: {
      blueForceTracking: fd.get("svc_bft") === "on",
      redForceTracking: fd.get("svc_rft") === "on",
      fotoweb: fd.get("svc_fotoweb") === "on",
      milestone: fd.get("svc_milestone") === "on",
      skisselag: fd.get("svc_skisselag") === "on",
      poi: fd.get("svc_poi") === "on",

      matrikkelEier: fd.get("svc_matrikkel") === "on",
      ruteberegning: fd.get("svc_rute") === "on",
      farligeStofferLager: fd.get("svc_farlige") === "on",
      kritiskInfrastruktur: fd.get("svc_kritisk") === "on",
      telekom: fd.get("svc_telekom") === "on"
    }
  });
}

function wireContentDependencies() {
  const appCb = document.querySelector(`#modalBody input[name="content_application"]`);
  const mapCb = document.querySelector(`#modalBody input[name="content_map"]`);
  const basemapCbs = Array.from(document.querySelectorAll(`#modalBody input[name="basemap"]`));
  const apptypeCbs = Array.from(document.querySelectorAll(`#modalBody input[name="apptype"]`));

  const enforce = () => {
    if (appCb && mapCb) {
      if (appCb.checked) {
        mapCb.checked = true;
        mapCb.disabled = true;
      } else {
        mapCb.disabled = false;
      }
    }
    apptypeCbs.forEach(cb => cb.disabled = !(appCb && appCb.checked));
    const mapOn = mapCb ? mapCb.checked : false;
    basemapCbs.forEach(cb => cb.disabled = !mapOn);
  };

  enforceExclusiveCheckboxGroup("apptype");

  appCb?.addEventListener("change", enforce);
  mapCb?.addEventListener("change", enforce);
  enforce();

  if (isAdmin()) {
    document.querySelector("#btnAddService")?.addEventListener("click", () => openAddLayerMenu());
  }
}

function openAddLayerMenu() {
  const body = `
    <div class="small">Velg hvordan du vil legge til et lag i operasjonen.</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px;">
      <button type="button" id="btnBrowseArcGIS">Bla gjennom lag i ArcGIS</button>
      <button type="button" id="btnAddFromUrl">Legg til lag fra URL</button>
      <button type="button" id="btnAddFromFile">Legg til lag fra fil</button>
    </div>
    <div class="small" style="margin-top:10px;">
      Dette er en demo/fake integrasjon – neste steg kan være å lagre "custom layers" på operasjonen.
    </div>
  `;

  showOverlayModal("Legg til lag (fake ArcGIS)", body, {
    large: false,
    onOpen: (dlg, content, close) => {
      content.querySelector("#btnBrowseArcGIS")?.addEventListener("click", () => {
        setStatus("Fake: Bla gjennom lag i ArcGIS (ikke implementert)");
        close();
      });
      content.querySelector("#btnAddFromUrl")?.addEventListener("click", () => {
        setStatus("Fake: Legg til lag fra URL (ikke implementert)");
        close();
      });
      content.querySelector("#btnAddFromFile")?.addEventListener("click", () => {
        setStatus("Fake: Legg til lag fra fil (ikke implementert)");
        close();
      });
    }
  });
}

async function editOperationContent(currentOperation) {
  if (!isAdmin()) return;
  const current = normalizeOperation(currentOperation);

  showModal(
    "Innhold for operasjon",
    contentEditorHtml(current.content),
    async (fd) => {
      const content = readContentFromForm(fd);
      const updated = normalizeOperation({ ...current, content });
      await putMany(db, "projects", [updated]);
      setStatus("Innhold oppdatert");
      await refreshAll();
    },
    { large: true, onOpen: () => wireContentDependencies() }
  );
}

// -------------------- Favoritt actions --------------------
async function createFavoriteGroup() {
  if (!isAdmin()) return;
  const nodes = await getFavoriteNodes();
  const options = nodes
    .filter(n => n.id !== null)
    .map(n => `<option value="${n.id}">${n.name}</option>`)
    .join("\n");

  const defaultParent = state.selectedFavoriteNodeId && state.viewMode === "favorite"
    ? state.selectedFavoriteNodeId
    : "favoritter";

  showModal(
    "Ny favorittgruppe",
    `
      <div class="field">
        <label>Navn</label>
        <input name="name" required placeholder="Spaning" />
      </div>
      <div class="field">
        <label>Legg under</label>
        <select name="parentId" required>
          ${options}
        </select>
      </div>
      <div class="small">En person kan ligge i flere favorittgrupper.</div>
    `,
    async (fd) => {
      const name = (fd.get("name") || "").toString().trim();
      const parentId = (fd.get("parentId") || "favoritter").toString();
      if (!name) throw new Error("Navn er påkrevd.");

      const node = {
        id: uuid("fav"),
        name,
        parentId,
        createdAt: new Date().toISOString(),
      };
      await putMany(db, "favoriteNodes", [node]);

      state.collapsed.delete("favoritter");
      state.collapsed.delete(parentId);
      state.viewMode = "favorite";
      state.selectedFavoriteNodeId = node.id;

      setStatus("Favorittgruppe opprettet");
      await refreshAll();
    }
  );

  const parentSel = document.querySelector("#modalBody select[name='parentId']");
  if (parentSel) parentSel.value = defaultParent;
}

async function addSelectedPersonToFavorite() {
  if (!isAdmin()) return;
  if (!state.selectedEmployeeId) {
    alert("Velg en person først.");
    return;
  }

  const nodes = await getFavoriteNodes();
  const options = nodes
    .filter(n => n.id !== "favoritter")
    .map(n => `<option value="${n.id}">${n.name}</option>`)
    .join("\n");

  if (!options) {
    alert("Du har ingen favorittgrupper ennå. Lag en først.");
    return;
  }

  const defaultNode = (state.viewMode === "favorite" && state.selectedFavoriteNodeId && state.selectedFavoriteNodeId !== "favoritter")
    ? state.selectedFavoriteNodeId
    : nodes.find(n => n.id !== "favoritter")?.id;

  showModal(
    "Legg valgt person i favoritt",
    `
      <div class="field">
        <label>Velg favorittgruppe</label>
        <select name="nodeId" required>
          ${options}
        </select>
      </div>
      <div class="small">Personen kan legges i flere favoritter.</div>
    `,
    async (fd) => {
      const nodeId = (fd.get("nodeId") || "").toString();
      if (!nodeId) throw new Error("Velg en favorittgruppe.");

      await addEmployeeToFavorite(nodeId, state.selectedEmployeeId);

      state.viewMode = "favorite";
      state.selectedFavoriteNodeId = nodeId;
      state.collapsed.delete("favoritter");
      state.collapsed.delete(nodeId);

      setStatus("La til person i favorittgruppe");
      await refreshAll();
    }
  );

  const sel = document.querySelector("#modalBody select[name='nodeId']");
  if (sel && defaultNode) sel.value = defaultNode;
}

async function removeSelectedPersonFromCurrentFavorite() {
  if (!isAdmin()) return;
  if (state.viewMode !== "favorite") {
    alert("Bytt til favoritt-visning og velg en favorittgruppe først.");
    return;
  }
  if (!state.selectedFavoriteNodeId || state.selectedFavoriteNodeId === "favoritter") {
    alert("Velg en favorittgruppe (ikke bare 'Favoritter').");
    return;
  }
  if (!state.selectedEmployeeId) {
    alert("Velg en person først.");
    return;
  }
  if (!confirm("Fjerne valgt person fra denne favorittgruppen?")) return;

  await removeEmployeeFromFavorite(state.selectedFavoriteNodeId, state.selectedEmployeeId);
  setStatus("Fjernet person fra favorittgruppe");
  await refreshAll();
}

// -------------------- Import / Export --------------------
async function exportJSON() {
  if (!isAdmin()) return;
  const [departments, employees, operations, operationMembers, favoriteNodes, favoriteMembers] = await Promise.all([
    getAll(db, "departments"),
    getAll(db, "employees"),
    getAll(db, "projects"),
    getAll(db, "projectMembers"),
    getAll(db, "favoriteNodes"),
    getAll(db, "favoriteMembers"),
  ]);

  const payload = {
    departments,
    employees,
    operations,
    operationMembers,
    projects: operations,
    projectMembers: operationMembers,
    favoriteNodes,
    favoriteMembers,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `org-demo-export_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();

  URL.revokeObjectURL(url);
  setStatus("Eksportert JSON");
}

async function importJSONFromFile(file) {
  if (!isAdmin()) return;
  const text = await file.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error("Filen er ikke gyldig JSON."); }

  const departments = payload.departments || [];
  const employees = payload.employees || [];
  const operations = (payload.operations || payload.projects || []).map(normalizeOperation);
  const operationMembers = payload.operationMembers || payload.projectMembers || [];
  const favoriteNodes = payload.favoriteNodes || [];
  const favoriteMembers = payload.favoriteMembers || [];

  await Promise.all([
    clearStore(db, "departments"),
    clearStore(db, "employees"),
    clearStore(db, "projects"),
    clearStore(db, "projectMembers"),
    clearStore(db, "favoriteNodes"),
    clearStore(db, "favoriteMembers"),
  ]);

  await putMany(db, "departments", departments);
  await putMany(db, "employees", employees);
  await putMany(db, "projects", operations);
  await putMany(db, "projectMembers", operationMembers);

  if (Array.isArray(favoriteNodes) && favoriteNodes.length) {
    await putMany(db, "favoriteNodes", favoriteNodes);
  } else {
    await putMany(db, "favoriteNodes", [{ id: "favoritter", name: "Favoritter", parentId: null, createdAt: new Date().toISOString() }]);
  }
  if (Array.isArray(favoriteMembers) && favoriteMembers.length) {
    await putMany(db, "favoriteMembers", favoriteMembers);
  }

  state.collapsed = new Set();
  state.collapsedInitialized = false;
  state.selectedDeptId = departments.find(d => d.parentId === null)?.id || (departments[0]?.id ?? null);
  state.selectedEmployeeId = null;
  state.selectedOperationId = operations[0]?.id ?? null;
  state.selectedFavoriteNodeId = null;
  state.viewMode = "dept";
  state.rightTab = "operation";
  state.search = "";
  state.operationMembersSort = "alpha";
  state.operationMembersView = "list";
  state.opMembersDeptFilterId = null;

  setStatus(`Importert ${departments.length} avd, ${employees.length} personer, ${operations.length} operasjoner`);
  await refreshAll();
}

// -------------------- Buttons enabled/disabled --------------------
function updateActionButtons() {
  const tabA = el("tabOperation");
  const tabB = el("tabPersonOps");
  if (tabA && tabB) {
    tabA.classList.toggle("primary", state.rightTab === "operation");
    tabB.classList.toggle("primary", state.rightTab === "person");
  }

  const hasOperation = !!state.selectedOperationId;
  const hasEmployee = !!state.selectedEmployeeId;

  const btnStatus = el("btnProjectStatus");
  if (btnStatus) btnStatus.disabled = !(hasOperation && isAdmin());

  const btnAddSelected = el("btnAddSelected");
  if (btnAddSelected) btnAddSelected.disabled = !(hasOperation && hasEmployee && isAdmin());

  const btnAddAll = el("btnAddAllFromDept");
  if (btnAddAll) {
    const hasScope =
      (state.viewMode === "dept" && !!state.selectedDeptId) ||
      (state.viewMode === "favorite" && !!state.selectedFavoriteNodeId && state.selectedFavoriteNodeId !== "favoritter");
    btnAddAll.disabled = !(hasOperation && hasScope && isAdmin());
    btnAddAll.textContent = (state.viewMode === "favorite") ? "Legg til alle fra favorittgruppe" : "Legg til alle fra valgt avdeling";
  }

  const btnAddToFav = el("btnAddToFavorite");
  const btnRemoveFromFav = el("btnRemoveFromFavorite");
  if (btnAddToFav) btnAddToFav.disabled = !(hasEmployee && isAdmin());

  const inFavoriteGroup =
    state.viewMode === "favorite" &&
    !!state.selectedFavoriteNodeId &&
    state.selectedFavoriteNodeId !== "favoritter";
  if (btnRemoveFromFav) btnRemoveFromFav.disabled = !(inFavoriteGroup && hasEmployee && isAdmin());
}

// -------------------- Create / Update operations --------------------
async function createOperation() {
  if (!isAdmin()) return;
  showModal(
    "Ny operasjon",
    `
      <div class="field">
        <label>Navn</label>
        <input name="name" required placeholder="Operasjon Ravn" />
      </div>
      <div class="field">
        <label>Status</label>
        <select name="status" required>
          <option value="Planlagt">Planlagt</option>
          <option value="Aktiv" selected>Aktiv</option>
          <option value="Avsluttet">Avsluttet</option>
        </select>
      </div>
      <hr style="opacity:.25;margin:12px 0;" />
      ${contentEditorHtml(DEFAULT_CONTENT)}
    `,
    async (fd) => {
      const name = (fd.get("name") || "").toString().trim();
      const status = (fd.get("status") || "").toString().trim();
      if (!name) throw new Error("Navn er påkrevd.");

      const content = readContentFromForm(fd);

      const op = normalizeOperation({
        id: uuid("op"),
        name,
        status,
        content
      });

      await putMany(db, "projects", [op]);
      state.selectedOperationId = op.id;

      setStatus("Operasjon opprettet");
      await refreshAll();
    },
    { large: true, onOpen: () => wireContentDependencies() }
  );
}

async function changeOperationStatus() {
  if (!isAdmin()) return;
  if (!state.selectedOperationId) {
    alert("Velg en operasjon først.");
    return;
  }
  const operations = (await getAll(db, "projects")).map(normalizeOperation);
  const current = operations.find(o => o.id === state.selectedOperationId);
  if (!current) return;

  showModal(
    "Endre operasjonsstatus",
    `
      <div class="field">
        <label>Operasjon</label>
        <input value="${current.name}" disabled />
      </div>
      <div class="field">
        <label>Status</label>
        <select name="status" required>
          <option value="Planlagt" ${current.status === "Planlagt" ? "selected" : ""}>Planlagt</option>
          <option value="Aktiv" ${current.status === "Aktiv" ? "selected" : ""}>Aktiv</option>
          <option value="Avsluttet" ${current.status === "Avsluttet" ? "selected" : ""}>Avsluttet</option>
        </select>
      </div>
    `,
    async (fd) => {
      const status = (fd.get("status") || "").toString().trim();
      const updated = { ...current, status };
      await putMany(db, "projects", [updated]);
      setStatus(`Status oppdatert: ${status}`);
      await refreshAll();
    }
  );
}

// -------------------- Wiring --------------------
async function wire() {
  el("btnExport")?.addEventListener("click", exportJSON);

  el("btnImport")?.addEventListener("click", () => {
    if (!isAdmin()) return;
    el("fileInput")?.click();
  });
  el("fileInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await importJSONFromFile(file);
    } catch (err) {
      alert(err?.message || String(err));
    } finally {
      e.target.value = "";
    }
  });

  el("btnReset")?.addEventListener("click", async () => {
    if (!isAdmin()) return;
    if (!confirm("Nullstille alle data i denne demoen?")) return;

    await Promise.all([
      clearStore(db, "departments"),
      clearStore(db, "employees"),
      clearStore(db, "projects"),
      clearStore(db, "projectMembers"),
      clearStore(db, "favoriteNodes"),
      clearStore(db, "favoriteMembers"),
    ]);

    Object.assign(state, {
      selectedDeptId: null,
      selectedEmployeeId: null,
      selectedOperationId: null,
      selectedFavoriteNodeId: null,
      viewMode: "dept",
      rightTab: "operation",
      search: "",
      collapsed: new Set(),
      collapsedInitialized: false,
      operationMembersSort: "alpha",
      operationMembersView: "list",
      opMembersDeptFilterId: null,
    });

    setStatus("Nullstilt");
    refreshAll();
  });

  el("includeChildren")?.addEventListener("change", (e) => {
    state.includeChildren = e.target.checked;
    refreshAll();
  });

  el("search")?.addEventListener("input", (e) => {
    state.search = e.target.value;
    refreshAll();
  });

  el("projectSelect")?.addEventListener("change", (e) => {
    state.selectedOperationId = e.target.value || null;
    refreshAll();
  });

  el("btnNewProject")?.addEventListener("click", createOperation);
  el("btnProjectStatus")?.addEventListener

  el("btnAddSelected")?.addEventListener("click", async () => {
    if (!isAdmin()) return;
    if (!state.selectedOperationId || !state.selectedEmployeeId) return;
    await addEmployeeToOperation(state.selectedOperationId, state.selectedEmployeeId, "Deltaker");
    setStatus("La til valgt person");
    refreshAll();
  });

  el("btnAddAllFromDept")?.addEventListener("click", async () => {
    await addAllFromSelectedScopeToOperation();
  });
}

// -------------------- Bootstrap --------------------
(async function init() {
  ensureUserFromUrlOrStorage();   // bestem admin/viewer før alt annet

  db = await openDB();
  await ensureFavoriteRoot();
  await wire();

  const btnNew = el("btnNewProject");
  if (btnNew) btnNew.textContent = "Ny operasjon";

  setStatus(`Klar (innlogget som ${state.currentUser} – ${state.currentUserProfile})`);
  await refreshAll();
})();