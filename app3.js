// Offline demo: IndexedDB + import/eksport JSON + tre + operasjoner + favoritter
// Design:
// - Operasjoner inneholder kun personer (mange-til-mange)
// - "Legg til alle ..." er engangskopi
// - Favoritter er et eget tre (undergrupper) der en person kan være i flere favoritter
// - I operasjons-panelet kan du bytte mellom:
//   (A) Administrere valgt operasjon, og
//   (B) Se/fjerne operasjoner for valgt person

const DB_NAME = "orgDemoDB";
const DB_VERSION = 5;

const state = {
  // valg / navigasjon
  selectedDeptId: null,
  selectedEmployeeId: null,
  selectedOperationId: null,

  // visning i høyre panel
  rightTab: "operation", // "operation" | "person"

  // favoritter
  selectedFavoriteNodeId: null, // valgt favorittgruppe i treet
  viewMode: "dept", // "dept" | "favorite"

  // filtre
  includeChildren: true,
  search: "",

  // tree state
  collapsed: new Set(),
  collapsedInitialized: false,
};

const el = (id) => document.getElementById(id);

function setStatus(msg) {
  const s = el("status");
  if (s) s.textContent = msg;
}

function uuid(prefix = "id") {
  return `${prefix}_${crypto.randomUUID()}`;
}

// -------------------- IndexedDB --------------------
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = req.result;
      const oldVersion = e.oldVersion || 0;
      const upTx = req.transaction;

      // departments
      if (!db.objectStoreNames.contains("departments")) {
        const dept = db.createObjectStore("departments", { keyPath: "id" });
        dept.createIndex("byParent", "parentId", { unique: false });
        dept.createIndex("byName", "name", { unique: false });
      }

      // employees
      if (!db.objectStoreNames.contains("employees")) {
        const emp = db.createObjectStore("employees", { keyPath: "id" });
        emp.createIndex("byDept", "deptId", { unique: false });
        emp.createIndex("byName", "name", { unique: false });
      }

      // operations (store-navn "projects" av kompatibilitetshensyn)
      if (!db.objectStoreNames.contains("projects")) {
        const proj = db.createObjectStore("projects", { keyPath: "id" });
        proj.createIndex("byName", "name", { unique: false });
      }

      // operationMembers (store-navn "projectMembers" av kompatibilitetshensyn)
      if (!db.objectStoreNames.contains("projectMembers")) {
        const mem = db.createObjectStore("projectMembers", { keyPath: "id" });
        mem.createIndex("byProject", "projectId", { unique: false });
        mem.createIndex("byEmployee", "employeeId", { unique: false });
      } else {
        // sørg for indekser (robust oppgradering)
        const mem = upTx.objectStore("projectMembers");
        if (!mem.indexNames.contains("byProject")) mem.createIndex("byProject", "projectId", { unique: false });
        if (!mem.indexNames.contains("byEmployee")) mem.createIndex("byEmployee", "employeeId", { unique: false });
      }

      // Favoritter (tre)
      if (!db.objectStoreNames.contains("favoriteNodes")) {
        const fn = db.createObjectStore("favoriteNodes", { keyPath: "id" });
        fn.createIndex("byParent", "parentId", { unique: false });
        fn.createIndex("byName", "name", { unique: false });
      } else {
        const fn = upTx.objectStore("favoriteNodes");
        if (!fn.indexNames.contains("byParent")) fn.createIndex("byParent", "parentId", { unique: false });
        if (!fn.indexNames.contains("byName")) fn.createIndex("byName", "name", { unique: false });
      }

      // Favoritt-medlemmer
      if (!db.objectStoreNames.contains("favoriteMembers")) {
        const fm = db.createObjectStore("favoriteMembers", { keyPath: "id" });
        fm.createIndex("byNode", "nodeId", { unique: false });
        fm.createIndex("byEmployee", "employeeId", { unique: false });
      } else {
        // PATCH B: sørg for at indekser finnes selv om store eksisterer fra før
        const fm = upTx.objectStore("favoriteMembers");
        if (!fm.indexNames.contains("byNode")) fm.createIndex("byNode", "nodeId", { unique: false });
        if (!fm.indexNames.contains("byEmployee")) fm.createIndex("byEmployee", "employeeId", { unique: false });
      }

      // Migrering fra eldre favoritter (best effort)
      // (Hvis du har kjørt en eldre variant med favoriteTeams/favoriteMembers-byTeam)
      if (oldVersion < 4 && db.objectStoreNames.contains("favoriteTeams")) {
        try {
          const nodesStore = upTx.objectStore("favoriteNodes");
          const newMembersStore = upTx.objectStore("favoriteMembers");

          // sørg for rot
          nodesStore.put({ id: "favoritter", name: "Favoritter", parentId: null, createdAt: new Date().toISOString() });

          const teamsStore = upTx.objectStore("favoriteTeams");
          const oldMembersStore = upTx.objectStore("favoriteMembers"); // kan være annen struktur, best effort

          const teamMap = new Map();
          const teamReq = teamsStore.openCursor();
          teamReq.onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (cursor) {
              const t = cursor.value;
              const nodeId = `fav_${t.id}`;
              teamMap.set(t.id, nodeId);
              nodesStore.put({
                id: nodeId,
                name: t.name || "Favoritt-team",
                parentId: "favoritter",
                createdAt: t.createdAt || new Date().toISOString(),
              });
              cursor.continue();
            } else {
              const memReq = oldMembersStore.openCursor();
              memReq.onsuccess = (ev2) => {
                const c2 = ev2.target.result;
                if (c2) {
                  const m = c2.value;
                  const newNodeId = teamMap.get(m.teamId) || `fav_${m.teamId}`;
                  const id = `${newNodeId}::${m.employeeId}`;
                  newMembersStore.put({
                    id,
                    nodeId: newNodeId,
                    employeeId: m.employeeId,
                    addedAt: m.addedAt || new Date().toISOString(),
                  });
                  c2.continue();
                }
              };
            }
          };
        } catch {
          // silent best-effort
        }
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

function initCollapsedDefault(childrenByParent) {
  // Ikke initialiser hvis treet er tomt (typisk før import)
  if (state.collapsedInitialized) return;
  const hasAny = childrenByParent.size > 0;
  if (!hasAny) return;

  for (const [parentId, kids] of childrenByParent.entries()) {
    if (parentId && kids && kids.length) state.collapsed.add(parentId);
  }

  // Hold toppnoder åpne
  state.collapsed.delete("politiet");
  state.collapsed.delete("politidistrikter");
  state.collapsed.delete("nasjonale-enheter");
  state.collapsed.delete("favoritter");

  state.collapsedInitialized = true;
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

// -------------------- UI wiring helpers (inject buttons/tabs) --------------------
function ensureRightPanelTabs() {
  // Vi lager tabs dynamisk i høyre panel for å slippe HTML-endringer.
  const panels = document.querySelectorAll("main.layout .panel");
  const rightPanel = panels?.[2];
  if (!rightPanel) return;

  // Endre overskrift til Operasjoner
  const h2 = rightPanel.querySelector(".panel-header h2");
  if (h2) h2.textContent = "Operasjoner";

  // Finn controls-linje
  const controls = rightPanel.querySelector(".panel-header .controls");
  if (!controls) return;

  // Sjekk om tabs allerede finnes
  if (rightPanel.querySelector("#tabOperation")) return;

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

  btnA.addEventListener("click", () => {
    state.rightTab = "operation";
    refreshAll();
  });
  btnB.addEventListener("click", () => {
    state.rightTab = "person";
    refreshAll();
  });

  tabWrap.appendChild(btnA);
  tabWrap.appendChild(btnB);

  // legg tabs under controls
  controls.parentElement.appendChild(tabWrap);
}

function ensureFavoriteButtons() {
  // Legg til knapper i topp-toolbar (hvis den finnes)
  const header = document.querySelector("header .toolbar");
  if (!header) return;
  if (header.querySelector("#btnNewFavoriteGroup")) return;

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

// -------------------- UI rendering --------------------
async function refreshAll() {
  ensureRightPanelTabs();
  ensureFavoriteButtons();

  // Hent data
  const [departments, employees, operations, opMembers, favoriteNodes] = await Promise.all([
    getAll(db, "departments"),
    getAll(db, "employees"),
    getAll(db, "projects"),
    getAll(db, "projectMembers"),
    getFavoriteNodes(),
  ]);

  // Maps
  const deptById = new Map(departments.map(d => [d.id, d]));
  const deptChildren = buildChildrenMap(departments);

  const favById = new Map(favoriteNodes.map(n => [n.id, n]));
  const favChildren = buildChildrenMap(favoriteNodes);

  // Inject Favoritter inn i departementstreet: legg "favoritter" under "politiet"
  injectFavoritesIntoDeptTree(deptChildren, favoriteNodes, favChildren);

  // collapsed init (viktig: etter injection)
  initCollapsedDefault(deptChildren);

  // Render venstre tre
  renderTree(employees, deptChildren);

  // Breadcrumb
  renderBreadcrumb(deptById, favById);

  // Render personliste (inkl undergrupper for favoritter)
  await renderEmployees(departments, employees, deptChildren, favChildren);

  // Render operasjoner select + status
  await renderOperations(operations);

  // Render høyre panel innhold avhengig av tab
  if (state.rightTab === "operation") {
    await renderOperationMembers(employees);
  } else {
    await renderSelectedPersonOperations(operations, opMembers);
  }

  updateActionButtons();
}

function injectFavoritesIntoDeptTree(deptChildren, favoriteNodes, favChildren) {
  // Sørg for at favoritter ligger under politiet
  const favRoot = { id: "favoritter", name: "Favoritter", parentId: "politiet", _type: "favRoot" };

  const politietKids = deptChildren.get("politiet") || [];
  if (!politietKids.some(x => x.id === "favoritter")) {
    politietKids.push(favRoot);
    politietKids.sort((a, b) => (a.name || "").localeCompare(b.name || "", "no"));
    deptChildren.set("politiet", politietKids);
  }

  // Favoritt-barn under "favoritter"
  const favKids = (favChildren.get("favoritter") || []).map(n => ({ ...n, _type: "favNode" }));
  deptChildren.set("favoritter", favKids);

  // For alle favoritt-noder: legg deres barn inn i deptChildren
  for (const n of favoriteNodes) {
    if (n.id === "favoritter") continue;
    const kids = (favChildren.get(n.id) || []).map(k => ({ ...k, _type: "favNode" }));
    if (kids.length) deptChildren.set(n.id, kids);
  }
}

function renderTree(employees, childrenByParent) {
  const treeEl = el("tree");
  if (!treeEl) return;
  treeEl.innerHTML = "";

  // count direkte ansatte pr dept
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
        // behold selectedDeptId for "hopp" fra person-klikk
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

async function renderEmployees(departments, employees, deptChildren, favChildren) {
  const listEl = el("employeeList");
  if (!listEl) return;
  listEl.innerHTML = "";

  let filtered = [];

  if (state.viewMode === "favorite") {
    if (!state.selectedFavoriteNodeId) {
      listEl.innerHTML = `<div class="small">Velg "Favoritter" i treet, og deretter en gruppe.</div>`;
      return;
    }

    // Undergrupper først (hvis de finnes)
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

    // Root: vis kun undergrupper
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
    if (state.viewMode === "favorite" && state.selectedFavoriteNodeId && state.selectedFavoriteNodeId !== "favoritter") {
      listEl.innerHTML += `<div class="small">Ingen personer i denne favorittgruppen (eller ingen matcher søk).</div>`;
    } else {
      listEl.innerHTML = `<div class="small">Ingen personer matcher filteret.</div>`;
    }
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

      // Marker avdeling i treet (åpne til dept)
      const deps = await getAll(db, "departments");
      const parentById = buildParentMap(deps);
      state.selectedDeptId = e.deptId;
      expandAncestors(e.deptId, parentById);

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

  if (!operations.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Ingen operasjoner";
    sel.appendChild(opt);
    state.selectedOperationId = null;
    if (info) info.textContent = "Opprett en operasjon for å legge til medlemmer.";
    return;
  }

  operations.sort((a, b) => (a.name || "").localeCompare(b.name || "", "no"));

  for (const op of operations) {
    const opt = document.createElement("option");
    opt.value = op.id;
    opt.textContent = op.name;
    sel.appendChild(opt);
  }

  if (!state.selectedOperationId || !operations.some(o => o.id === state.selectedOperationId)) {
    state.selectedOperationId = operations[0].id;
  }

  sel.value = state.selectedOperationId;

  const current = operations.find(o => o.id === state.selectedOperationId);
  if (info) info.textContent = current ? `${current.name} (${current.status || "—"})` : "Velg en operasjon";
}

async function renderOperationMembers(employees) {
  const list = el("projectMembers");
  if (!list) return;

  const panels = document.querySelectorAll("main.layout .panel");
  const rightPanel = panels?.[2];
  const sub = rightPanel?.querySelector(".subheader");
  if (sub) sub.textContent = "Medlemmer i operasjon";

  list.innerHTML = "";

  if (!state.selectedOperationId) {
    list.innerHTML = `<div class="small">Velg eller opprett en operasjon.</div>`;
    return;
  }

  const memberships = await getByIndex(db, "projectMembers", "byProject", state.selectedOperationId);
  if (!memberships.length) {
    list.innerHTML = `<div class="small">Ingen medlemmer i operasjonen enda.</div>`;
    return;
  }

  const empById = new Map(employees.map(e => [e.id, e]));
  const rows = memberships.map(m => ({ m, e: empById.get(m.employeeId) })).filter(x => x.e);

  rows.sort((a, b) => (a.e.name || "").localeCompare(b.e.name || "", "no"));

  for (const r of rows) {
    const item = document.createElement("div");
    item.className = "item";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = r.e.name;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<span>${r.e.title || "—"}</span><span>lagt til: ${new Date(r.m.addedAt).toLocaleString("no-NO")}</span>`;

    const btn = document.createElement("button");
    btn.textContent = "Fjern";
    btn.style.marginTop = "8px";
    btn.addEventListener("click", async () => {
      await deleteKey(db, "projectMembers", r.m.id);
      setStatus("Fjernet fra operasjon");
      refreshAll();
    });

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(btn);
    list.appendChild(item);
  }
}

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

  const opById = new Map(operations.map(o => [o.id, o]));
  const rows = memberships
    .map(m => ({ m, op: opById.get(m.projectId) }))
    .filter(x => x.op);

  rows.sort((a, b) => (a.op.name || "").localeCompare(b.op.name || "", "no"));

  for (const r of rows) {
    const item = document.createElement("div");
    item.className = "item";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = r.op.name;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<span>Status: ${r.op.status || "—"}</span><span>lagt til: ${new Date(r.m.addedAt).toLocaleString("no-NO")}</span>`;

    const btn = document.createElement("button");
    btn.textContent = "Fjern personen fra operasjonen";
    btn.style.marginTop = "8px";
    btn.addEventListener("click", async () => {
      await deleteKey(db, "projectMembers", r.m.id);
      setStatus("Fjernet personen fra operasjon");
      refreshAll();
    });

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(btn);
    list.appendChild(item);
  }
}

function updateActionButtons() {
  // Tab buttons state
  const tabA = el("tabOperation");
  const tabB = el("tabPersonOps");
  if (tabA && tabB) {
    tabA.classList.toggle("primary", state.rightTab === "operation");
    tabB.classList.toggle("primary", state.rightTab === "person");
  }

  const hasOperation = !!state.selectedOperationId;
  const hasEmployee = !!state.selectedEmployeeId;

  const btnAddSelected = el("btnAddSelected");
  const btnAddAll = el("btnAddAllFromDept");
  const btnStatus = el("btnProjectStatus");

  if (btnStatus) btnStatus.disabled = !hasOperation;
  if (btnAddSelected) btnAddSelected.disabled = !(hasOperation && hasEmployee);

  if (btnAddAll) {
    const hasScope =
      (state.viewMode === "dept" && !!state.selectedDeptId) ||
      (state.viewMode === "favorite" && !!state.selectedFavoriteNodeId && state.selectedFavoriteNodeId !== "favoritter");
    btnAddAll.disabled = !(hasOperation && hasScope);
    btnAddAll.textContent = (state.viewMode === "favorite")
      ? "Legg til alle fra favorittgruppe"
      : "Legg til alle fra valgt avdeling";
  }

  // Favoritt-knapper
  const btnAddToFav = el("btnAddToFavorite");
  const btnRemoveFromFav = el("btnRemoveFromFavorite");

  const inFavoriteGroup =
    state.viewMode === "favorite" &&
    !!state.selectedFavoriteNodeId &&
    state.selectedFavoriteNodeId !== "favoritter";

  if (btnAddToFav) btnAddToFav.disabled = !hasEmployee;
  if (btnRemoveFromFav) btnRemoveFromFav.disabled = !(inFavoriteGroup && hasEmployee);
}

// -------------------- Actions --------------------
async function addEmployeeToOperation(operationId, employeeId) {
  const id = `${operationId}::${employeeId}`;
  await putMany(db, "projectMembers", [{
    id,
    projectId: operationId,
    employeeId,
    addedAt: new Date().toISOString(),
  }]);
}

async function addManyEmployeesToOperation(employeeIds) {
  const existing = await getByIndex(db, "projectMembers", "byProject", state.selectedOperationId);
  const existingSet = new Set(existing.map(m => m.employeeId));

  const toAdd = [];
  for (const eid of employeeIds) {
    if (!existingSet.has(eid)) {
      toAdd.push({
        id: `${state.selectedOperationId}::${eid}`,
        projectId: state.selectedOperationId,
        employeeId: eid,
        addedAt: new Date().toISOString(),
      });
    }
  }

  await putMany(db, "projectMembers", toAdd);
  return toAdd.length;
}

async function addAllFromSelectedScopeToOperation() {
  if (!state.selectedOperationId) return;

  if (state.viewMode === "favorite") {
    const nodeId = state.selectedFavoriteNodeId;
    if (!nodeId || nodeId === "favoritter") return;

    const members = await getFavoriteMembers(nodeId);
    const ids = members.map(m => m.employeeId);
    const added = await addManyEmployeesToOperation(ids);
    setStatus(`La til ${added} personer fra favorittgruppe (engangskopi)`);
    return;
  }

  // dept
  if (!state.selectedDeptId) return;
  const [departments, employees] = await Promise.all([
    getAll(db, "departments"),
    getAll(db, "employees"),
  ]);
  const children = buildChildrenMap(departments);
  const deptIds = collectDescendantIds(children, state.selectedDeptId);
  const deptSet = new Set(deptIds);
  const candidates = employees.filter(e => deptSet.has(e.deptId));

  const added = await addManyEmployeesToOperation(candidates.map(e => e.id));
  setStatus(`La til ${added} personer fra avdeling (engangskopi)`);
}

// -------------------- Modals --------------------
function showModal(title, bodyHtml, onOk) {
  const modal = el("modal");
  if (!modal) return;

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
      } catch (err) {
        alert(err?.message || String(err));
      }
    }
  };

  form.addEventListener("submit", handler, { once: true });
}

// -------------------- Favorites UI actions --------------------
async function createFavoriteGroup() {
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

      // åpne parent + fokus
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

      // PATCH A: hopp til gruppa, åpne i treet, så du ser personen umiddelbart
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
  const text = await file.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Filen er ikke gyldig JSON.");
  }

  const departments = payload.departments || [];
  const employees = payload.employees || [];
  const operations = payload.operations || payload.projects || [];
  const operationMembers = payload.operationMembers || payload.projectMembers || [];
  const favoriteNodes = payload.favoriteNodes || [];
  const favoriteMembers = payload.favoriteMembers || [];

  if (!Array.isArray(departments) || !Array.isArray(employees) || !Array.isArray(operations) || !Array.isArray(operationMembers)) {
    throw new Error("JSON må inneholde arrays: departments, employees, operations/projects, operationMembers/projectMembers");
  }

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

  // Reset collapsed init så default kollaps blir brukt på nytt
  state.collapsed = new Set();
  state.collapsedInitialized = false;

  state.selectedDeptId = departments.find(d => d.parentId === null)?.id || (departments[0]?.id ?? null);
  state.selectedEmployeeId = null;
  state.selectedOperationId = operations[0]?.id ?? null;
  state.selectedFavoriteNodeId = null;
  state.viewMode = "dept";
  state.rightTab = "operation";
  state.search = "";

  setStatus(`Importert ${departments.length} avd, ${employees.length} personer, ${operations.length} operasjoner`);
  await refreshAll();
}

// -------------------- Create / Update entities --------------------
async function createOperation() {
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
    `,
    async (fd) => {
      const name = (fd.get("name") || "").toString().trim();
      const status = (fd.get("status") || "").toString().trim();
      if (!name) throw new Error("Navn er påkrevd.");

      const op = { id: uuid("op"), name, status: status || "Aktiv" };
      await putMany(db, "projects", [op]);
      state.selectedOperationId = op.id;
      setStatus("Operasjon opprettet");
      await refreshAll();
    }
  );
}

async function changeOperationStatus() {
  if (!state.selectedOperationId) {
    alert("Velg en operasjon først.");
    return;
  }

  const operations = await getAll(db, "projects");
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

  el("btnImport")?.addEventListener("click", () => el("fileInput")?.click());
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
    if (!confirm("Nullstille alle data i denne demoen?")) return;

    await Promise.all([
      clearStore(db, "departments"),
      clearStore(db, "employees"),
      clearStore(db, "projects"),
      clearStore(db, "projectMembers"),
      clearStore(db, "favoriteNodes"),
      clearStore(db, "favoriteMembers"),
    ]);

    state.selectedDeptId = null;
    state.selectedEmployeeId = null;
    state.selectedOperationId = null;
    state.selectedFavoriteNodeId = null;
    state.viewMode = "dept";
    state.rightTab = "operation";
    state.search = "";
    state.collapsed = new Set();
    state.collapsedInitialized = false;

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
  el("btnProjectStatus")?.addEventListener("click", changeOperationStatus);

  el("btnAddSelected")?.addEventListener("click", async () => {
    if (!state.selectedOperationId || !state.selectedEmployeeId) return;
    await addEmployeeToOperation(state.selectedOperationId, state.selectedEmployeeId);
    setStatus("La til valgt person");
    refreshAll();
  });

  el("btnAddAllFromDept")?.addEventListener("click", async () => {
    await addAllFromSelectedScopeToOperation();
    refreshAll();
  });
}

// -------------------- Bootstrap --------------------
(async function init() {
  db = await openDB();
  await ensureFavoriteRoot();
  await wire();

  // Oppdater noen UI-tekster hvis de finnes
  const btnNew = el("btnNewProject");
  if (btnNew) btnNew.textContent = "Ny operasjon";

  setStatus("Klar (tips: Import JSON for å fylle demoen)");
  await refreshAll();
})();