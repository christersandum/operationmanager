// Offline demo: IndexedDB + import/eksport JSON + tre + prosjekter
// Design: prosjekter inneholder kun personer. "Legg til alle fra avdeling" er engangskopi.
// En person kan være medlem i flere prosjekter.

const DB_NAME = "orgDemoDB";
const DB_VERSION = 2;

const state = {
  selectedDeptId: null,
  selectedEmployeeId: null,
  selectedProjectId: null,
  includeChildren: true,
  search: "",
  collapsed: new Set(),
  collapsedInitialized: false
};

const el = (id) => document.getElementById(id);
const statusEl = el("status");

function setStatus(msg) {
  statusEl.textContent = msg;
}

function uuid(prefix="id") {
  return `${prefix}_${crypto.randomUUID()}`;
}

// -------------------- IndexedDB --------------------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;

      // departments
      const dept = db.createObjectStore("departments", { keyPath: "id" });
      dept.createIndex("byParent", "parentId", { unique: false });
      dept.createIndex("byName", "name", { unique: false });

      // employees
      const emp = db.createObjectStore("employees", { keyPath: "id" });
      emp.createIndex("byDept", "deptId", { unique: false });
      emp.createIndex("byName", "name", { unique: false });

      // projects
      const proj = db.createObjectStore("projects", { keyPath: "id" });
      proj.createIndex("byName", "name", { unique: false });

      // memberships: key = `${projectId}::${employeeId}`
      const mem = db.createObjectStore("projectMembers", { keyPath: "id" });
      mem.createIndex("byProject", "projectId", { unique: false });
      mem.createIndex("byEmployee", "employeeId", { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(db, storeName, mode="readonly") {
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
    items.forEach(item => {
      const req = store.put(item);
      req.onsuccess = () => { pending--; if (pending === 0) resolve(); };
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
function buildChildrenMap(departments) {
  const childrenByParent = new Map();
  for (const d of departments) {
    const p = d.parentId ?? null;
    if (!childrenByParent.has(p)) childrenByParent.set(p, []);
    childrenByParent.get(p).push(d);
  }
  // stable sort by name
  for (const [k, arr] of childrenByParent.entries()) {
    arr.sort((a,b) => (a.name || "").localeCompare(b.name || "", "no"));
  }
  return childrenByParent;
}

function getDeptPath(departmentsById, deptId) {
  const path = [];
  let cur = departmentsById.get(deptId);
  while (cur) {
    path.push(cur.name);
    cur = cur.parentId ? departmentsById.get(cur.parentId) : null;
  }
  return path.reverse().join(" → ");
}

function collectDescendantDeptIds(childrenByParent, rootId) {
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

// -------------------- UI rendering --------------------
let db;

async function refreshAll() {
  const [departments, employees, projects] = await Promise.all([
    getAll(db, "departments"),
    getAll(db, "employees"),
    getAll(db, "projects"),
  ]);

  const departmentsById = new Map(departments.map(d => [d.id, d]));
  const childrenByParent = buildChildrenMap(departments);
  initCollapsedDefault(childrenByParent);


  renderTree(departments, employees, childrenByParent);
  renderDeptBreadcrumb(departmentsById);
  await renderEmployees(departments, employees, childrenByParent);
  await renderProjects(projects);
  await renderProjectMembers(employees);
  updateActionButtons();
}

function renderTree(departments, employees, childrenByParent) {
  const treeEl = el("tree");
  treeEl.innerHTML = "";

  // Precompute counts (employees directly under dept)
  const countByDept = new Map();
  for (const e of employees) {
    countByDept.set(e.deptId, (countByDept.get(e.deptId) || 0) + 1);
  }

  function renderNode(dept, container) {
    const kids = childrenByParent.get(dept.id) || [];
    const hasKids = kids.length > 0;
    const isCollapsed = state.collapsed.has(dept.id);

    const row = document.createElement("div");
    row.className = "node" + (state.selectedDeptId === dept.id ? " selected" : "");
    row.dataset.deptId = dept.id;

    const caret = document.createElement("div");
    caret.className = "caret";
    caret.textContent = hasKids ? (isCollapsed ? "▸" : "▾") : "•";

    // Toggle collapse only when clicking caret
    if (hasKids) {
      caret.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (state.collapsed.has(dept.id)) state.collapsed.delete(dept.id);
        else state.collapsed.add(dept.id);
        refreshAll();
      });
    }

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = dept.name;

    const count = document.createElement("div");
    count.className = "count";
    count.textContent = `${countByDept.get(dept.id) || 0}`;

    row.appendChild(caret);
    row.appendChild(name);
    row.appendChild(count);

    // Clicking row selects the department
    row.addEventListener("click", () => {
      state.selectedDeptId = dept.id;
      state.selectedEmployeeId = null;
      refreshAll();
    });


    row.addEventListener("dblclick", (ev) => {
      if (!hasKids) return;
      if (state.collapsed.has(dept.id)) state.collapsed.delete(dept.id);
      else state.collapsed.add(dept.id);
    refreshAll();
    });


    container.appendChild(row);

    // Render children only if not collapsed
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

  // Scroll selected node into view for better UX
  const selected = treeEl.querySelector(".node.selected");
  if (selected) selected.scrollIntoView({ block: "nearest" });
}

function renderDeptBreadcrumb(departmentsById) {
  const bc = el("deptBreadcrumb");
  if (!state.selectedDeptId) {
    bc.textContent = "Ingen avdeling valgt";
    return;
  }
  bc.textContent = getDeptPath(departmentsById, state.selectedDeptId);
}

async function renderEmployees(departments, employees, childrenByParent) {
  const listEl = el("employeeList");
  listEl.innerHTML = "";

  if (!state.selectedDeptId) {
    listEl.innerHTML = `<div class="small">Velg en avdeling i treet.</div>`;
    return;
  }

  const deptIds = state.includeChildren
    ? collectDescendantDeptIds(childrenByParent, state.selectedDeptId)
    : [state.selectedDeptId];

  const deptSet = new Set(deptIds);

  let filtered = employees.filter(e => deptSet.has(e.deptId));

  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    filtered = filtered.filter(e => (e.name || "").toLowerCase().includes(q));
  }

  // Sort by name
  filtered.sort((a,b) => (a.name||"").localeCompare(b.name||"", "no"));

  // Lightweight paging for snappiness
  const MAX = 200;
  const shown = filtered.slice(0, MAX);

  if (!shown.length) {
    listEl.innerHTML = `<div class="small">Ingen personer matcher filteret.</div>`;
    return;
  }

  for (const e of shown) {
    const item = document.createElement("div");
    item.className = "item" + (state.selectedEmployeeId === e.id ? " selected" : "");
    
    item.addEventListener("click", async () => {
    state.selectedEmployeeId = e.id;

    // Når person velges: hopp/marker avdeling i venstrekolonnen
    const departments = await getAll(db, "departments");
    const parentById = buildParentMap(departments);

    state.selectedDeptId = e.deptId;               // marker vedkommendes underavdeling
    expandAncestors(e.deptId, parentById);         // åpne treet ned til riktig node

    await refreshAll();                            // re-render alt (inkl tre og breadcrumb)
    updateActionButtons();
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

  if (filtered.length > MAX) {
    const note = document.createElement("div");
    note.className = "small";
    note.textContent = `Viser ${MAX} av ${filtered.length} treff. Avgrens med søk.`;
    listEl.appendChild(note);
  }
}

function buildParentMap(departments) {
  const parentById = new Map();
  for (const d of departments) parentById.set(d.id, d.parentId ?? null);
  return parentById;
}

function expandAncestors(deptId, parentById) {
  // åpner alle “foreldre” ved å fjerne dem fra collapsed-settet
  let cur = deptId;
  while (cur) {
    const parent = parentById.get(cur);
    if (parent) state.collapsed.delete(parent);
    cur = parent;
  }
}

function renderSelectedEmployeeHighlight() {
  // re-render is easiest; but we keep it light: just refresh
  // For correctness with paging/filtering, refreshAll is safe.
  // We'll just refresh employees to update selection highlight.
  refreshAll();
}

async function renderProjects(projects) {
  const sel = el("projectSelect");
  sel.innerHTML = "";

  if (!projects.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Ingen prosjekter";
    sel.appendChild(opt);
    state.selectedProjectId = null;
    el("projectInfo").textContent = "Opprett et prosjekt for å legge til medlemmer.";
    return;
  }

  projects.sort((a,b) => (a.name||"").localeCompare(b.name||"", "no"));

  for (const p of projects) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }

  if (!state.selectedProjectId || !projects.some(p => p.id === state.selectedProjectId)) {
    state.selectedProjectId = projects[0].id;
  }

  sel.value = state.selectedProjectId;
  const current = projects.find(p => p.id === state.selectedProjectId);
  el("projectInfo").textContent = current ? `${current.name} (${current.status || "—"})` : "Velg et prosjekt";
}

async function renderProjectMembers(employees) {
  const list = el("projectMembers");
  list.innerHTML = "";

  if (!state.selectedProjectId) {
    list.innerHTML = `<div class="small">Velg eller opprett et prosjekt.</div>`;
    return;
  }

  const memberships = await getByIndex(db, "projectMembers", "byProject", state.selectedProjectId);
  if (!memberships.length) {
    list.innerHTML = `<div class="small">Ingen medlemmer i prosjektet enda.</div>`;
    return;
  }

  const empById = new Map(employees.map(e => [e.id, e]));
  const rows = memberships
    .map(m => ({ m, e: empById.get(m.employeeId) }))
    .filter(x => x.e);

  rows.sort((a,b) => (a.e.name||"").localeCompare(b.e.name||"", "no"));

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
      setStatus("Fjernet fra prosjekt");
      refreshAll();
    });

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(btn);
    list.appendChild(item);
  }
}

function updateActionButtons() {
  const hasProject = !!state.selectedProjectId;
  const hasEmployee = !!state.selectedEmployeeId;
  const hasDept = !!state.selectedDeptId;

  el("btnAddSelected").disabled = !(hasProject && hasEmployee);
  el("btnAddAllFromDept").disabled = !(hasProject && hasDept);

  // Ny: statusknapp
  const statusBtn = el("btnProjectStatus");
  if (statusBtn) statusBtn.disabled = !hasProject;
}

// -------------------- Actions --------------------
async function addEmployeeToProject(projectId, employeeId) {
  const id = `${projectId}::${employeeId}`;
  const membership = {
    id,
    projectId,
    employeeId,
    addedAt: new Date().toISOString()
  };
  await putMany(db, "projectMembers", [membership]);
}

async function addAllFromSelectedDeptToProject() {
  const [departments, employees] = await Promise.all([
    getAll(db, "departments"),
    getAll(db, "employees"),
  ]);
  const childrenByParent = buildChildrenMap(departments);

  const deptIds = collectDescendantDeptIds(childrenByParent, state.selectedDeptId);
  const deptSet = new Set(deptIds);
  const candidates = employees.filter(e => deptSet.has(e.deptId));

  // existing members
  const existing = await getByIndex(db, "projectMembers", "byProject", state.selectedProjectId);
  const existingSet = new Set(existing.map(m => m.employeeId));

  const toAdd = [];
  for (const e of candidates) {
    if (!existingSet.has(e.id)) {
      toAdd.push({
        id: `${state.selectedProjectId}::${e.id}`,
        projectId: state.selectedProjectId,
        employeeId: e.id,
        addedAt: new Date().toISOString()
      });
    }
  }

  await putMany(db, "projectMembers", toAdd);
  setStatus(`La til ${toAdd.length} personer fra avdeling (engangskopi)`);
}

// -------------------- Modal helpers --------------------
function initCollapsedDefault(childrenByParent) {
  if (state.collapsedInitialized) return;

  // Kollaps alle noder som har barn
  for (const [parentId, kids] of childrenByParent.entries()) {
    if (parentId && kids && kids.length) state.collapsed.add(parentId);
  }

  // Valgfritt: hold noen “toppnoder” åpne for bedre UX:
  state.collapsed.delete("politiet");
  state.collapsed.delete("politidistrikter");
  state.collapsed.delete("nasjonale-enheter");
  state.collapsed.delete("favoritter"); // kommer i steg 2

  state.collapsedInitialized = true;
}

function showModal(title, bodyHtml, onOk) {
  const modal = el("modal");
  el("modalTitle").textContent = title;
  const body = el("modalBody");
  body.innerHTML = bodyHtml;

  modal.showModal();

  const form = el("modalForm");
  const okBtn = el("modalOk");

  const handler = async (e) => {
    // e.submitter only supported in modern browsers; ok for Edge/Chrome
    const isOk = e.submitter === okBtn;
    if (isOk) {
      e.preventDefault(); // keep open until done
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

// -------------------- Import / Export --------------------
async function exportJSON() {
  const [departments, employees, projects, projectMembers] = await Promise.all([
    getAll(db, "departments"),
    getAll(db, "employees"),
    getAll(db, "projects"),
    getAll(db, "projectMembers")
  ]);

  const payload = { departments, employees, projects, projectMembers };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `org-demo-export_${new Date().toISOString().slice(0,10)}.json`;
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

  const { departments, employees, projects, projectMembers } = payload;

  if (!Array.isArray(departments) || !Array.isArray(employees) || !Array.isArray(projects) || !Array.isArray(projectMembers)) {
    throw new Error("JSON må inneholde arrays: departments, employees, projects, projectMembers");
  }

  // Overwrite everything (demo-safe)
  await Promise.all([
    clearStore(db, "departments"),
    clearStore(db, "employees"),
    clearStore(db, "projects"),
    clearStore(db, "projectMembers")
  ]);

  await putMany(db, "departments", departments);
  await putMany(db, "employees", employees);
  await putMany(db, "projects", projects);
  await putMany(db, "projectMembers", projectMembers);

  // auto-select some defaults
  state.selectedDeptId = departments.find(d => d.parentId === null)?.id || (departments[0]?.id ?? null);
  state.selectedProjectId = projects[0]?.id ?? null;
  state.selectedEmployeeId = null;

  setStatus(`Importert ${departments.length} avd, ${employees.length} personer, ${projects.length} prosjekter`);
  await refreshAll();
}

// -------------------- Create entities --------------------
async function createProject() {
  showModal(
    "Nytt prosjekt",
    `
      <div class="field">
        <label>Navn</label>
        <input name="name" required placeholder="Operasjon Ravn" />
      </div>
      <div class="field">
        <label>Status</label>
        <input name="status" placeholder="Aktiv" />
      </div>
    `,
    async (fd) => {
      const name = (fd.get("name") || "").toString().trim();
      const status = (fd.get("status") || "").toString().trim();
      if (!name) throw new Error("Navn er påkrevd.");

      const p = { id: uuid("p"), name, status: status || "Aktiv" };
      await putMany(db, "projects", [p]);
      state.selectedProjectId = p.id;
      setStatus("Prosjekt opprettet");
      await refreshAll();
    }
  );
}

async function changeProjectStatus() {
  if (!state.selectedProjectId) {
    alert("Velg et prosjekt først.");
    return;
  }

  const projects = await getAll(db, "projects");
  const current = projects.find(p => p.id === state.selectedProjectId);
  if (!current) return;

  showModal(
    "Endre prosjektstatus",
    `
      <div class="field">
        <label>Prosjekt</label>
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

async function createEmployee() {
  if (!state.selectedDeptId) {
    alert("Velg en avdeling først.");
    return;
  }

  showModal(
    "Ny person",
    `
      <div class="field">
        <label>Navn</label>
        <input name="name" required placeholder="Ola Nordmann" />
      </div>
      <div class="field">
        <label>Tittel/rolle</label>
        <input name="title" placeholder="Analytiker" />
      </div>
    `,
    async (fd) => {
      const name = (fd.get("name") || "").toString().trim();
      const title = (fd.get("title") || "").toString().trim();
      if (!name) throw new Error("Navn er påkrevd.");

      const e = { id: uuid("e"), name, title, deptId: state.selectedDeptId };
      await putMany(db, "employees", [e]);
      setStatus("Person opprettet");
      await refreshAll();
    }
  );
}

async function createSubDepartment() {
  if (!state.selectedDeptId) {
    alert("Velg en avdeling i treet først (parent).");
    return;
  }

  showModal(
    "Ny underavdeling",
    `
      <div class="field">
        <label>Navn</label>
        <input name="name" required placeholder="Krimteknisk avdeling" />
      </div>
    `,
    async (fd) => {
      const name = (fd.get("name") || "").toString().trim();
      if (!name) throw new Error("Navn er påkrevd.");

      const d = { id: uuid("d"), name, parentId: state.selectedDeptId };
      await putMany(db, "departments", [d]);
      setStatus("Underavdeling opprettet");
      await refreshAll();
    }
  );
}

// -------------------- Wiring --------------------
async function wire() {
  el("btnExport").addEventListener("click", exportJSON);
  el("btnProjectStatus").addEventListener("click", changeProjectStatus);

  el("btnImport").addEventListener("click", () => el("fileInput").click());
  el("fileInput").addEventListener("change", async (e) => {
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

  el("btnReset").addEventListener("click", async () => {
    if (!confirm("Nullstille alle data i denne demoen?")) return;
    await Promise.all([
      clearStore(db, "departments"),
      clearStore(db, "employees"),
      clearStore(db, "projects"),
      clearStore(db, "projectMembers")
    ]);
    state.selectedDeptId = null;
    state.selectedEmployeeId = null;
    state.selectedProjectId = null;
    setStatus("Nullstilt");
    refreshAll();
  });

  el("includeChildren").addEventListener("change", (e) => {
    state.includeChildren = e.target.checked;
    refreshAll();
  });

  el("search").addEventListener("input", (e) => {
    state.search = e.target.value;
    // only rerender employees list for responsiveness
    refreshAll();
  });

  el("projectSelect").addEventListener("change", (e) => {
    state.selectedProjectId = e.target.value || null;
    updateActionButtons();
    refreshAll();
  });

  el("btnNewProject").addEventListener("click", createProject);
  el("btnNewEmp").addEventListener("click", createEmployee);
  el("btnNewDept").addEventListener("click", createSubDepartment);

  el("btnAddSelected").addEventListener("click", async () => {
    if (!state.selectedProjectId || !state.selectedEmployeeId) return;
    await addEmployeeToProject(state.selectedProjectId, state.selectedEmployeeId);
    setStatus("La til valgt person");
    refreshAll();
  });

  el("btnAddAllFromDept").addEventListener("click", async () => {
    if (!state.selectedProjectId || !state.selectedDeptId) return;
    await addAllFromSelectedDeptToProject();
    refreshAll();
  });
}

// -------------------- Bootstrap --------------------
(async function init() {
  db = await openDB();
  await wire();
  setStatus("Klar (tips: Import JSON for å fylle demoen)");
  await refreshAll();
})();