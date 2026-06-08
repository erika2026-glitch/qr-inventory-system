const STORE_KEY = 'qrInventoryApp:v1';
const STAFF_KEY = 'qrInventoryApp:staffName';
const SUPABASE = window.SUPABASE_CONFIG || null;

const state = loadState();
const el = (id) => document.getElementById(id);

const viewMeta = {
  dashboard: ['Dashboard', 'Live stock summary and recent movement'],
  scan: ['Scan', 'Post IN and OUT transactions from QR codes'],
  inventory: ['Inventory', 'Manage rolls, weights, and stock status'],
  transactions: ['Transactions', 'Audit trail of all movement'],
  reports: ['Reports', 'Weekly inventory report and closing'],
  labels: ['QR Labels', 'Print labels for current inventory items'],
  settings: ['Settings', 'Backup, restore, and local data controls']
};

let selectedItem = null;
let scanStream = null;
let scanTimer = null;
let scanAnimation = null;
let cloudEnabled = false;

document.addEventListener('DOMContentLoaded', async () => {
  bindNavigation();
  bindActions();
  await initCloud();
  applyHashScan();
  renderAll();
});

window.addEventListener('hashchange', applyHashScan);

function loadState() {
  const saved = localStorage.getItem(STORE_KEY);
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch {
      localStorage.removeItem(STORE_KEY);
    }
  }

  return {
    items: (window.STARTER_ITEMS || []).map((item) => normalizeItemShape(item)),
    transactions: [],
    closedWeeks: [],
    nextItemNumber: (window.STARTER_ITEMS || []).length + 1
  };
}

function saveState() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

async function initCloud() {
  if (!SUPABASE?.url || !SUPABASE?.key) {
    setSyncStatus('Local mode', 'offline');
    return;
  }

  try {
    setSyncStatus('Connecting to Supabase...', '');
    const cloudItems = await cloudSelect('items', 'select=*&order=id.asc');
    if (!cloudItems.length) {
      await seedCloudItems();
    }

    const [items, transactions] = await Promise.all([
      cloudSelect('items', 'select=*&order=id.asc'),
      cloudSelect('transactions', 'select=*&order=created_at.asc')
    ]);

    state.items = items.map(fromDbItem);
    state.transactions = transactions.map(fromDbTransaction);
    state.nextItemNumber = nextItemNumberFromItems(state.items);
    saveState();
    cloudEnabled = true;
    setSyncStatus('Online database connected', 'online');
  } catch (error) {
    cloudEnabled = false;
    setSyncStatus('Offline/local fallback', 'offline');
    toast(`Supabase not connected: ${error.message}`);
  }
}

async function seedCloudItems() {
  const starterItems = (window.STARTER_ITEMS || []).map(toDbItem);
  if (!starterItems.length) return;
  await cloudInsert('items', starterItems);
}

async function cloudSelect(table, query) {
  const response = await fetch(`${SUPABASE.url}/rest/v1/${table}?${query}`, {
    headers: cloudHeaders()
  });
  return readCloudResponse(response);
}

async function cloudInsert(table, rows) {
  const response = await fetch(`${SUPABASE.url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      ...cloudHeaders(),
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(rows)
  });
  return readCloudResponse(response);
}

async function cloudPatch(table, idColumn, idValue, row) {
  const response = await fetch(`${SUPABASE.url}/rest/v1/${table}?${idColumn}=eq.${encodeURIComponent(idValue)}`, {
    method: 'PATCH',
    headers: {
      ...cloudHeaders(),
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(row)
  });
  return readCloudResponse(response);
}

function cloudHeaders() {
  return {
    apikey: SUPABASE.key,
    Authorization: `Bearer ${SUPABASE.key}`
  };
}

async function readCloudResponse(response) {
  const text = await response.text();
  const data = text ? JSON.parse(text) : [];
  if (!response.ok) {
    const message = data.message || data.error_description || data.error || response.statusText;
    throw new Error(message);
  }
  return data;
}

function setSyncStatus(message, status) {
  const box = el('syncStatus');
  if (!box) return;
  box.textContent = message;
  box.className = `sync-status ${status || ''}`;
}

function bindNavigation() {
  document.querySelectorAll('.nav-btn').forEach((button) => {
    button.addEventListener('click', () => showView(button.dataset.view));
  });
}

function bindActions() {
  el('findBtn').addEventListener('click', () => selectScanValue(el('scanInput').value));
  el('scanInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') selectScanValue(el('scanInput').value);
  });
  el('cameraBtn').addEventListener('click', toggleCameraScan);
  el('inventorySearch').addEventListener('input', renderInventory);
  el('categoryFilter').addEventListener('change', renderInventory);
  el('txSearch').addEventListener('input', renderTransactions);
  el('txActionFilter').addEventListener('change', renderTransactions);
  el('labelSearch').addEventListener('input', renderLabels);
  el('applyReportBtn').addEventListener('click', renderReports);
  el('reportCategoryFilter').addEventListener('change', renderReports);
  el('printReportBtn').addEventListener('click', () => printMode('report'));
  el('closeWeekBtn').addEventListener('click', closeWeek);
  el('printBtn').addEventListener('click', () => printMode('labels'));
  el('exportBtn').addEventListener('click', exportTransactionsCsv);
  el('backupBtn').addEventListener('click', downloadBackup);
  el('downloadBackupBtn').addEventListener('click', downloadBackup);
  el('restoreInput').addEventListener('change', restoreBackup);
  el('downloadItemTemplateBtn').addEventListener('click', downloadItemTemplate);
  el('itemImportInput').addEventListener('change', importItemsCsv);
  el('resetBtn').addEventListener('click', resetLocalData);
  el('saveStaffBtn').addEventListener('click', saveStaffName);
  el('addItemBtn').addEventListener('click', () => el('itemDialog').showModal());
  el('cancelItemBtn').addEventListener('click', () => el('itemDialog').close());
  el('itemForm').addEventListener('submit', saveNewItem);
  initializeReportDates();
  el('staffNameInput').value = getStaffName();
}

function showView(view) {
  document.querySelectorAll('.nav-btn').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.id === view));
  el('viewTitle').textContent = viewMeta[view][0];
  el('viewSubtitle').textContent = viewMeta[view][1];
  if (view !== 'scan') stopCamera();
}

function renderAll() {
  renderCategories();
  renderDashboard();
  renderInventory();
  renderTransactions();
  renderReports();
  renderLabels();
}

function renderCategories() {
  const select = el('categoryFilter');
  const current = select.value;
  const categories = [...new Set(activeItems().map((item) => item.category).filter(Boolean))].sort();
  select.innerHTML = '<option value="">All categories</option>' + categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
  select.value = current;

  const reportSelect = el('reportCategoryFilter');
  if (reportSelect) {
    const reportCurrent = reportSelect.value;
    reportSelect.innerHTML = '<option value="">All categories</option>' + categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
    reportSelect.value = reportCurrent;
  }
}

function renderDashboard() {
  const items = activeItems();
  const totalRolls = items.reduce((sum, item) => sum + Number(item.currentRolls || 0), 0);
  const totalWeight = items.reduce((sum, item) => sum + Number(item.currentWeight || 0), 0);
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = state.transactions.filter((tx) => tx.timestamp.slice(0, 10) === today).length;

  el('mRolls').textContent = formatNumber(totalRolls, 0);
  el('mWeight').textContent = formatNumber(totalWeight, 2);
  el('mItems').textContent = items.length;
  el('mToday').textContent = todayCount;

  el('recentRows').innerHTML = state.transactions.slice(-8).reverse().map((tx) => {
    const item = state.items.find((row) => row.id === tx.itemId) || {};
    return `<tr>
      <td>${formatDate(tx.timestamp)}</td>
      <td>${escapeHtml(tx.itemId)}</td>
      <td>${escapeHtml(item.product || tx.product || '')}</td>
      <td><span class="pill ${tx.action.toLowerCase()}">${tx.action}</span></td>
      <td>${formatNumber(tx.rolls, 0)}</td>
      <td>${formatNumber(tx.totalWeight, 2)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="6">No transactions yet.</td></tr>`;
}

function renderInventory() {
  const query = el('inventorySearch').value.trim().toLowerCase();
  const category = el('categoryFilter').value;
  const rows = activeItems().filter((item) => {
    const text = `${item.id} ${item.category} ${item.product} ${item.gauge} ${item.meters} ${item.remarks}`.toLowerCase();
    return (!query || text.includes(query)) && (!category || item.category === category);
  });

  const grouped = groupBy(rows, (item) => item.category || 'Uncategorized');
  const html = [];

  for (const [category, items] of grouped.entries()) {
    items.forEach((item) => {
    const movement = getItemMovement(item.id);
    const endingRolls = Number(item.beginningRolls || 0) + movement.inRolls - movement.outRolls;
    const endingWeight = Number(item.beginningWeight || 0) + movement.inWeight - movement.outWeight;
    item.currentRolls = endingRolls;
    item.currentWeight = Math.max(0, endingWeight);
    const status = endingRolls <= 0 ? 'low' : endingRolls <= Number(item.minRolls || 0) ? 'warn' : 'ok';
    const label = status === 'ok' ? 'OK' : status === 'warn' ? 'LOW' : 'ZERO';
    html.push(`<tr>
      <td>${escapeHtml(item.id)}</td>
      <td>${escapeHtml(item.category)}</td>
      <td>${escapeHtml(item.product)}</td>
      <td>${escapeHtml(item.gauge)}</td>
      <td>${escapeHtml(item.meters)}</td>
      <td>${escapeHtml(item.remarks)}</td>
      <td>${formatBlankZero(item.beginningRolls, 0)}</td>
      <td>${formatBlankZero(item.beginningWeight, 2)}</td>
      <td>${formatBlankZero(movement.inRolls, 0)}</td>
      <td>${formatBlankZero(movement.inWeight, 2)}</td>
      <td>${formatBlankZero(movement.outRolls, 0)}</td>
      <td>${formatBlankZero(movement.outWeight, 2)}</td>
      <td>${formatBlankZero(endingRolls, 0)}</td>
      <td>${formatBlankZero(Math.max(0, endingWeight), 2)}</td>
      <td><span class="pill ${status}">${label}</span></td>
    </tr>`);
    });

    html.push(buildInventoryCategoryTotalRow(category, items));
  }

  el('inventoryRows').innerHTML = html.join('') || `<tr><td colspan="15">No matching items.</td></tr>`;
}

function getItemMovement(itemId) {
  return state.transactions
    .filter((tx) => tx.itemId === itemId)
    .reduce((totals, tx) => {
      const rolls = Number(tx.rolls || 0);
      const weight = Number(tx.totalWeight || 0);
      if (tx.action === 'IN') {
        totals.inRolls += rolls;
        totals.inWeight += weight;
      } else if (tx.action === 'OUT') {
        totals.outRolls += rolls;
        totals.outWeight += weight;
      }
      return totals;
    }, { inRolls: 0, inWeight: 0, outRolls: 0, outWeight: 0 });
}

function buildInventoryTotalRows(rows) {
  const totals = [];
  const grouped = groupBy(rows, (item) => item.category || 'Uncategorized');
  for (const [category, items] of grouped.entries()) {
    const total = items.reduce((sum, item) => {
      const movement = getItemMovement(item.id);
      const beginningRolls = Number(item.beginningRolls || 0);
      const beginningWeight = Number(item.beginningWeight || 0);
      const endingRolls = beginningRolls + movement.inRolls - movement.outRolls;
      const endingWeight = Math.max(0, beginningWeight + movement.inWeight - movement.outWeight);
      sum.beginningRolls += beginningRolls;
      sum.beginningWeight += beginningWeight;
      sum.inRolls += movement.inRolls;
      sum.inWeight += movement.inWeight;
      sum.outRolls += movement.outRolls;
      sum.outWeight += movement.outWeight;
      sum.endingRolls += endingRolls;
      sum.endingWeight += endingWeight;
      return sum;
    }, emptyTotals());
    totals.push(buildInventoryTotalRow(category, total));
  }
  return totals;
}

function emptyTotals() {
  return {
    beginningRolls: 0,
    beginningWeight: 0,
    inRolls: 0,
    inWeight: 0,
    outRolls: 0,
    outWeight: 0,
    endingRolls: 0,
    endingWeight: 0
  };
}

function buildInventoryCategoryTotalRow(category, items) {
  const total = items.reduce((sum, item) => {
    const movement = getItemMovement(item.id);
    const beginningRolls = Number(item.beginningRolls || 0);
    const beginningWeight = Number(item.beginningWeight || 0);
    const endingRolls = beginningRolls + movement.inRolls - movement.outRolls;
    const endingWeight = Math.max(0, beginningWeight + movement.inWeight - movement.outWeight);
    sum.beginningRolls += beginningRolls;
    sum.beginningWeight += beginningWeight;
    sum.inRolls += movement.inRolls;
    sum.inWeight += movement.inWeight;
    sum.outRolls += movement.outRolls;
    sum.outWeight += movement.outWeight;
    sum.endingRolls += endingRolls;
    sum.endingWeight += endingWeight;
    return sum;
  }, emptyTotals());
  return buildInventoryTotalRow(category, total);
}

function buildInventoryTotalRow(category, total) {
  return `<tr class="total-row">
      <td></td>
      <td>${escapeHtml(category)}</td>
      <td>TOTAL</td>
      <td></td>
      <td></td>
      <td></td>
      <td>${formatBlankZero(total.beginningRolls, 0)}</td>
      <td>${formatBlankZero(total.beginningWeight, 2)}</td>
      <td>${formatBlankZero(total.inRolls, 0)}</td>
      <td>${formatBlankZero(total.inWeight, 2)}</td>
      <td>${formatBlankZero(total.outRolls, 0)}</td>
      <td>${formatBlankZero(total.outWeight, 2)}</td>
      <td>${formatBlankZero(total.endingRolls, 0)}</td>
      <td>${formatBlankZero(total.endingWeight, 2)}</td>
      <td></td>
    </tr>`;
}

function totalRowHtml(category, total) {
  return `<tr class="total-row">
    <td>TOTAL</td>
    <td>${formatBlankZero(total.beginningRolls, 0)}</td>
    <td>${formatBlankZero(total.beginningWeight, 2)}</td>
    <td>${formatBlankZero(total.inRolls, 0)}</td>
    <td>${formatBlankZero(total.inWeight, 2)}</td>
    <td>${formatBlankZero(total.outRolls, 0)}</td>
    <td>${formatBlankZero(total.outWeight, 2)}</td>
    <td>${formatBlankZero(total.endingRolls, 0)}</td>
    <td>${formatBlankZero(total.endingWeight, 2)}</td>
    <td></td>
  </tr>`;
}

function renderTransactions() {
  const query = el('txSearch').value.trim().toLowerCase();
  const action = el('txActionFilter').value;
  const rows = state.transactions.filter((tx) => {
    const item = state.items.find((row) => row.id === tx.itemId) || {};
    const text = `${tx.itemId} ${item.product || tx.product || ''} ${tx.action} ${tx.user || ''}`.toLowerCase();
    return (!query || text.includes(query)) && (!action || tx.action === action);
  }).slice().reverse();

  el('transactionRows').innerHTML = rows.map((tx) => {
    const item = state.items.find((row) => row.id === tx.itemId) || {};
    return `<tr>
      <td>${formatDate(tx.timestamp)}</td>
      <td>${escapeHtml(tx.itemId)}</td>
      <td>${escapeHtml(item.product || tx.product || '')}</td>
      <td><span class="pill ${tx.action.toLowerCase()}">${tx.action}</span></td>
      <td>${formatNumber(tx.rolls, 0)}</td>
      <td>${formatNumber(tx.weightPerRoll, 2)}</td>
      <td>${formatNumber(tx.totalWeight, 2)}</td>
      <td>${formatNumber(tx.balanceAfter, 0)}</td>
      <td>${escapeHtml(tx.user || '')}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="9">No transactions yet.</td></tr>`;
}

function initializeReportDates() {
  const today = new Date();
  const start = new Date(today);
  const day = today.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  start.setDate(today.getDate() + mondayOffset);
  const end = new Date(start);
  end.setDate(start.getDate() + 5);
  if (!el('reportFrom').value) el('reportFrom').value = toDateInput(start);
  if (!el('reportTo').value) el('reportTo').value = toDateInput(end);
}

function renderReports() {
  const from = el('reportFrom').value;
  const to = el('reportTo').value;
  const summaries = buildWeeklySummary(from, to);
  const selectedCategory = el('reportCategoryFilter').value;
  const filteredSummaries = selectedCategory ? summaries.filter((row) => row.category === selectedCategory) : summaries;
  const rangeText = from && to ? `Inventory Report as of ${formatShortDate(from)} to ${formatShortDate(to)}` : 'Weekly Inventory Report';
  el('reportRangeTitle').textContent = rangeText;

  const grouped = groupBy(filteredSummaries, (row) => row.category || 'Uncategorized');
  const html = [];
  let reportNumber = 1;
  let categoryNumber = 1;
  for (const [category, rows] of grouped.entries()) {
    html.push(`<tr class="category-row"><td colspan="12">${romanNumeral(categoryNumber++)}. ${escapeHtml(category)}</td></tr>`);
    const total = emptyTotals();
    rows.forEach((row) => {
      total.beginningRolls += row.beginningRolls;
      total.beginningWeight += row.beginningWeight;
      total.inRolls += row.inRolls;
      total.inWeight += row.inWeight;
      total.outRolls += row.outRolls;
      total.outWeight += row.outWeight;
      total.endingRolls += row.endingRolls;
      total.endingWeight += row.endingWeight;
      html.push(`<tr>
        <td>${reportNumber++} ${escapeHtml(row.item.product)}</td>
        <td>${escapeHtml(row.item.gauge)}</td>
        <td>${escapeHtml(row.item.meters)}</td>
        <td>${escapeHtml(row.item.remarks)}</td>
        <td>${formatBlankZero(row.beginningRolls, 0)}</td>
        <td>${formatBlankZero(row.beginningWeight, 2)}</td>
        <td>${formatBlankZero(row.inRolls, 0)}</td>
        <td>${formatBlankZero(row.inWeight, 2)}</td>
        <td>${formatBlankZero(row.outRolls, 0)}</td>
        <td>${formatBlankZero(row.outWeight, 2)}</td>
        <td>${formatBlankZero(row.endingRolls, 0)}</td>
        <td>${formatBlankZero(row.endingWeight, 2)}</td>
      </tr>`);
    });
    html.push(reportCategoryTotalRow(category, total));
  }
  el('reportRows').innerHTML = html.join('') || `<tr><td colspan="12">No inventory rows.</td></tr>`;
  renderClosedWeeks();
}

function reportCategoryTotalRow(category, total) {
  return `<tr class="total-row">
    <td>${escapeHtml(category)} TOTAL</td>
    <td></td>
    <td></td>
    <td></td>
    <td>${formatBlankZero(total.beginningRolls, 0)}</td>
    <td>${formatBlankZero(total.beginningWeight, 2)}</td>
    <td>${formatBlankZero(total.inRolls, 0)}</td>
    <td>${formatBlankZero(total.inWeight, 2)}</td>
    <td>${formatBlankZero(total.outRolls, 0)}</td>
    <td>${formatBlankZero(total.outWeight, 2)}</td>
    <td>${formatBlankZero(total.endingRolls, 0)}</td>
    <td>${formatBlankZero(total.endingWeight, 2)}</td>
  </tr>`;
}

function romanNumeral(value) {
  const numerals = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let number = value;
  let result = '';
  for (const [amount, symbol] of numerals) {
    while (number >= amount) {
      result += symbol;
      number -= amount;
    }
  }
  return result || String(value);
}

function buildReportGrandTotals(rows) {
  const totalRows = [];
  const grouped = groupBy(rows, (row) => row.category || 'Uncategorized');
  for (const [category, items] of grouped.entries()) {
    const total = items.reduce((sum, row) => {
      sum.beginningRolls += row.beginningRolls;
      sum.beginningWeight += row.beginningWeight;
      sum.inRolls += row.inRolls;
      sum.inWeight += row.inWeight;
      sum.outRolls += row.outRolls;
      sum.outWeight += row.outWeight;
      sum.endingRolls += row.endingRolls;
      sum.endingWeight += row.endingWeight;
      return sum;
    }, emptyTotals());
    totalRows.push(`<tr class="total-row">
      <td>${escapeHtml(category)} TOTAL</td>
      <td>${formatBlankZero(total.beginningRolls, 0)}</td>
      <td>${formatBlankZero(total.beginningWeight, 2)}</td>
      <td>${formatBlankZero(total.inRolls, 0)}</td>
      <td>${formatBlankZero(total.inWeight, 2)}</td>
      <td>${formatBlankZero(total.outRolls, 0)}</td>
      <td>${formatBlankZero(total.outWeight, 2)}</td>
      <td>${formatBlankZero(total.endingRolls, 0)}</td>
      <td>${formatBlankZero(total.endingWeight, 2)}</td>
    </tr>`);
  }
  return totalRows;
}

function buildWeeklySummary(from, to) {
  const fromDate = from ? new Date(`${from}T00:00:00`) : null;
  const toDate = to ? new Date(`${to}T23:59:59`) : null;

  return activeItems().map((item) => {
    const periodTx = state.transactions.filter((tx) => {
      const txDate = new Date(tx.timestamp);
      return tx.itemId === item.id && (!fromDate || txDate >= fromDate) && (!toDate || txDate <= toDate);
    });
    const totals = periodTx.reduce((sum, tx) => {
      const rolls = Number(tx.rolls || 0);
      const weight = Number(tx.totalWeight || 0);
      if (tx.action === 'IN') {
        sum.inRolls += rolls;
        sum.inWeight += weight;
      } else if (tx.action === 'OUT') {
        sum.outRolls += rolls;
        sum.outWeight += weight;
      }
      return sum;
    }, { inRolls: 0, inWeight: 0, outRolls: 0, outWeight: 0 });
    const beginningRolls = Number(item.beginningRolls ?? item.currentRolls ?? 0);
    const beginningWeight = Number(item.beginningWeight ?? item.currentWeight ?? 0);
    const endingRolls = beginningRolls + totals.inRolls - totals.outRolls;
    const endingWeight = Math.max(0, beginningWeight + totals.inWeight - totals.outWeight);
    return {
      item,
      category: item.category,
      beginningRolls,
      beginningWeight,
      ...totals,
      endingRolls,
      endingWeight
    };
  });
}

function renderClosedWeeks() {
  const weeks = state.closedWeeks || [];
  el('closedWeeksRows').innerHTML = weeks.slice().reverse().map((week) => `<tr>
    <td>${escapeHtml(week.from)} to ${escapeHtml(week.to)}</td>
    <td>${formatDate(week.closedAt)}</td>
    <td>${week.itemCount}</td>
    <td>${formatNumber(week.totalEndingRolls, 0)}</td>
    <td>${formatNumber(week.totalEndingWeight, 2)}</td>
  </tr>`).join('') || `<tr><td colspan="5">No closed weeks yet.</td></tr>`;
}

function closeWeek() {
  const from = el('reportFrom').value;
  const to = el('reportTo').value;
  if (!from || !to) {
    toast('Choose a report date range first.');
    return;
  }
  if (!confirm(`Close week ${from} to ${to}? Ending inventory will become the new beginning inventory.`)) {
    return;
  }

  const summary = buildWeeklySummary(from, to);
  summary.forEach((row) => {
    row.item.beginningRolls = row.endingRolls;
    row.item.beginningWeight = row.endingWeight;
    row.item.currentRolls = row.endingRolls;
    row.item.currentWeight = row.endingWeight;
  });
  state.closedWeeks = state.closedWeeks || [];
  state.closedWeeks.push({
    from,
    to,
    closedAt: new Date().toISOString(),
    itemCount: summary.length,
    totalEndingRolls: summary.reduce((sum, row) => sum + row.endingRolls, 0),
    totalEndingWeight: summary.reduce((sum, row) => sum + row.endingWeight, 0),
    rows: summary.map((row) => ({
      id: row.item.id,
      product: row.item.product,
      beginningRolls: row.beginningRolls,
      beginningWeight: row.beginningWeight,
      inRolls: row.inRolls,
      inWeight: row.inWeight,
      outRolls: row.outRolls,
      outWeight: row.outWeight,
      endingRolls: row.endingRolls,
      endingWeight: row.endingWeight
    }))
  });
  saveState();
  syncClosedWeekToCloud(summary);
  renderAll();
  toast('Week closed. Ending inventory is now the next beginning inventory.');
}

function renderLabels() {
  const query = el('labelSearch').value.trim().toLowerCase();
  const items = activeItems().filter((item) => {
    const text = `${item.id} ${item.category} ${item.product} ${item.gauge} ${item.meters} ${item.remarks}`.toLowerCase();
    return !query || text.includes(query);
  });

  el('labelGrid').innerHTML = items.map((item) => {
    const payload = `${location.origin}${location.pathname}#scan:${encodeURIComponent(item.id)}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(payload)}`;
    return `<div class="qr-label">
      <img src="${qrUrl}" alt="QR for ${escapeHtml(item.id)}">
      <div>
        <strong>${escapeHtml(item.id)}</strong>
        <span>${escapeHtml(item.product)}</span>
        <span>${escapeHtml(item.gauge)} · ${escapeHtml(item.meters)} · ${escapeHtml(item.remarks)}</span>
        <span>${formatNumber(item.currentRolls, 0)} rolls</span>
      </div>
    </div>`;
  }).join('');
}

function selectScanValue(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) {
    toast('Enter or scan a QR value.');
    return;
  }

  const item = findItem(value);
  if (!item) {
    selectedItem = null;
    renderScanResult();
    toast('QR not found in inventory.');
    return;
  }

  selectedItem = item;
  el('scanInput').value = item.id;
  renderScanResult();
}

function findItem(value) {
  const decoded = decodeURIComponent(String(value).trim());
  const hashMatch = decoded.match(/#scan:([^#]+)/);
  const idMatch = decoded.match(/(?:^|[?&])id=([^&#]+)/);
  const candidate = hashMatch ? hashMatch[1] : idMatch ? idMatch[1] : decoded;
  const normalized = decodeURIComponent(candidate).trim();

  return activeItems().find((item) => item.id.toLowerCase() === normalized.toLowerCase())
    || activeItems().find((item) => legacyQrText(item).toLowerCase() === normalized.toLowerCase());
}

function renderScanResult() {
  const panel = el('scanResult');
  if (!selectedItem) {
    panel.className = 'item-panel empty';
    panel.innerHTML = '<div><h2>No item selected</h2><p>Scan or enter a QR ID to begin.</p></div>';
    return;
  }

  panel.className = 'item-panel';
  panel.innerHTML = `
    <h2>${escapeHtml(selectedItem.product)}</h2>
    <p>${escapeHtml(selectedItem.category)} · ${escapeHtml(selectedItem.id)}</p>
    <div class="item-detail">
      <div class="detail-box"><span>Gauge</span><strong>${escapeHtml(selectedItem.gauge)}</strong></div>
      <div class="detail-box"><span>Meters/Roll</span><strong>${escapeHtml(selectedItem.meters)}</strong></div>
      <div class="detail-box"><span>Remarks</span><strong>${escapeHtml(selectedItem.remarks)}</strong></div>
      <div class="detail-box"><span>Available Rolls</span><strong>${formatNumber(selectedItem.currentRolls, 0)}</strong></div>
      <div class="detail-box"><span>Available Weight</span><strong>${formatNumber(selectedItem.currentWeight, 2)}</strong></div>
      <div class="detail-box"><span>Weight/Roll</span><strong>${formatNumber(selectedItem.weightPerRoll, 2)}</strong></div>
    </div>
    <div class="action-form">
      <label>Rolls<input id="actionRolls" type="number" min="1" step="1" value="1"></label>
      <label>Scanned By<input id="actionUser" placeholder="Name or initials" value="${escapeHtml(getStaffName())}"></label>
      <button class="primary" id="postInBtn">Delivery</button>
      <button class="danger" id="postOutBtn">Issuance</button>
    </div>
  `;

  document.getElementById('postInBtn').addEventListener('click', () => postTransaction('IN'));
  document.getElementById('postOutBtn').addEventListener('click', () => postTransaction('OUT'));
}

function postTransaction(action) {
  if (!selectedItem) return;
  const rolls = Number(document.getElementById('actionRolls').value);
  const user = document.getElementById('actionUser').value.trim();
  const actionLabel = action === 'IN' ? 'DELIVERY' : 'ISSUANCE';

  if (!Number.isFinite(rolls) || rolls <= 0) {
    toast('Enter a valid roll quantity.');
    return;
  }
  if (action === 'OUT' && rolls > Number(selectedItem.currentRolls || 0)) {
    toast(`Blocked: only ${formatNumber(selectedItem.currentRolls, 0)} roll(s) available.`);
    return;
  }

  const weightPerRoll = Number(selectedItem.weightPerRoll || 0);
  const totalWeight = rolls * weightPerRoll;
  const signedRolls = action === 'IN' ? rolls : -rolls;
  const signedWeight = action === 'IN' ? totalWeight : -totalWeight;
  selectedItem.currentRolls = Number(selectedItem.currentRolls || 0) + signedRolls;
  selectedItem.currentWeight = Math.max(0, Number(selectedItem.currentWeight || 0) + signedWeight);

  state.transactions.push({
    timestamp: new Date().toISOString(),
    itemId: selectedItem.id,
    product: selectedItem.product,
    action,
    rolls,
    weightPerRoll,
    totalWeight,
    balanceAfter: selectedItem.currentRolls,
    user
  });
  if (user) {
    localStorage.setItem(STAFF_KEY, user);
    const staffInput = el('staffNameInput');
    if (staffInput) staffInput.value = user;
  }

  saveState();
  syncTransactionToCloud(selectedItem, state.transactions[state.transactions.length - 1]);
  renderAll();
  renderScanResult();
  toast(`${actionLabel} successful for ${selectedItem.id}.`);
}

async function syncTransactionToCloud(item, transaction) {
  if (!cloudEnabled) return;
  try {
    await cloudInsert('transactions', [toDbTransaction(transaction)]);
    await cloudPatch('items', 'id', item.id, {
      current_rolls: item.currentRolls,
      current_weight: item.currentWeight
    });
    setSyncStatus('Online database connected', 'online');
  } catch (error) {
    setSyncStatus('Sync error', 'offline');
    toast(`Saved locally, but cloud sync failed: ${error.message}`);
  }
}

async function toggleCameraScan() {
  if (scanStream) {
    stopCamera();
    return;
  }

  try {
    const video = el('scanVideo');
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = scanStream;
    video.style.display = 'block';
    await video.play();
    el('cameraBtn').textContent = 'Stop Camera Scan';

    if ('BarcodeDetector' in window) {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      scanTimer = window.setInterval(async () => {
        const codes = await detector.detect(video);
        if (codes.length) {
          selectScanValue(codes[0].rawValue);
          stopCamera();
        }
      }, 600);
      return;
    }

    if (window.jsQR) {
      scanWithCanvas(video);
      return;
    }

    toast('Camera opened, but QR decoder did not load. Use the QR ID input field.');
  } catch (error) {
    toast(error.message || 'Unable to start camera.');
    stopCamera();
  }
}

function scanWithCanvas(video) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });

  const tick = () => {
    if (!scanStream) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(imageData.data, imageData.width, imageData.height);
      if (code?.data) {
        selectScanValue(code.data);
        stopCamera();
        return;
      }
    }
    scanAnimation = window.requestAnimationFrame(tick);
  };

  tick();
}

function stopCamera() {
  if (scanTimer) window.clearInterval(scanTimer);
  scanTimer = null;
  if (scanAnimation) window.cancelAnimationFrame(scanAnimation);
  scanAnimation = null;
  if (scanStream) {
    scanStream.getTracks().forEach((track) => track.stop());
  }
  scanStream = null;
  el('scanVideo').style.display = 'none';
  el('cameraBtn').textContent = 'Start Camera Scan';
}

function saveNewItem(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const weightPerRoll = Number(form.get('weightPerRoll') || 0);
  const currentRolls = Number(form.get('currentRolls') || 0);
  const item = {
    id: `QR-${String(state.nextItemNumber++).padStart(5, '0')}`,
    category: form.get('category').trim(),
    product: form.get('product').trim(),
    gauge: form.get('gauge').trim(),
    meters: form.get('meters').trim(),
    remarks: form.get('remarks').trim(),
    weightPerRoll,
    currentRolls,
    currentWeight: currentRolls * weightPerRoll,
    minRolls: 1
  };
  state.items.push(item);
  saveState();
  syncNewItemToCloud(item);
  event.currentTarget.reset();
  el('itemDialog').close();
  renderAll();
  toast(`Added ${item.id}.`);
}

function printMode(mode) {
  document.body.dataset.printMode = mode;
  window.setTimeout(() => window.print(), 50);
}

window.addEventListener('afterprint', () => {
  delete document.body.dataset.printMode;
});

async function syncNewItemToCloud(item) {
  if (!cloudEnabled) return;
  try {
    await cloudInsert('items', [toDbItem(item)]);
  } catch (error) {
    setSyncStatus('Sync error', 'offline');
    toast(`Item saved locally, but cloud sync failed: ${error.message}`);
  }
}

async function syncNewItemsToCloud(items) {
  if (!cloudEnabled || !items.length) return;
  try {
    await cloudInsert('items', items.map(toDbItem));
    setSyncStatus('Online database connected', 'online');
  } catch (error) {
    setSyncStatus('Sync error', 'offline');
    toast(`Items saved locally, but cloud sync failed: ${error.message}`);
  }
}

function downloadItemTemplate() {
  const rows = [
    ['category', 'product', 'gauge', 'meters', 'remarks', 'weightPerRoll', 'beginningRolls'],
    ['BOPP PLAIN', '675mm (11-30-23)', '20', '6000', 'WEIFU', '71.80', '6'],
    ['MATT', '775mm (03-14-25)', '20', '6000', 'JOHNNY-SAMPLE', '27.20', '1']
  ];
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n');
  downloadText('qr-inventory-items-template.csv', csv, 'text/csv');
}

function importItemsCsv(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const rows = file.name.toLowerCase().endsWith('.csv')
        ? parseCsv(reader.result)
        : parseWorkbookRows(reader.result);
      const importedItems = rowsToImportItems(rows);
      if (!importedItems.length) throw new Error('No valid item rows found.');
      state.items.push(...importedItems);
      state.nextItemNumber = nextItemNumberFromItems(state.items);
      saveState();
      await syncNewItemsToCloud(importedItems);
      renderAll();
      toast(`Imported ${importedItems.length} item${importedItems.length === 1 ? '' : 's'}.`);
    } catch (error) {
      toast(error.message);
    } finally {
      event.target.value = '';
    }
  };
  if (file.name.toLowerCase().endsWith('.csv')) {
    reader.readAsText(file);
  } else {
    reader.readAsArrayBuffer(file);
  }
}

function rowsToImportItems(rows) {
  if (rows.length < 2) return [];
  const templateHeaderIndex = findHeaderRowIndex(rows, ['category', 'product']);
  if (templateHeaderIndex >= 0) {
    return rowsToTemplateItems(rows.slice(templateHeaderIndex));
  }
  return rowsToReportItems(rows);
}

function rowsToTemplateItems(rows) {
  const headers = rows[0].map(normalizeHeader);
  return rows.slice(1).map((row) => {
    const get = (...names) => {
      for (const name of names.map(normalizeHeader)) {
        const index = headers.indexOf(name);
        if (index >= 0) return String(row[index] || '').trim();
      }
      return '';
    };
    const category = get('category');
    const product = get('product', 'product description', 'description', 'item');
    if (!category && !product) return null;
    if (!category || !product) throw new Error('Each import row needs category and product.');
    if (product.trim().toUpperCase() === 'TOTAL') return null;
    const beginningRolls = parseImportNumber(get('beginningRolls', 'beg rolls', 'no of rolls', 'current rolls', 'rolls'));
    const beginningWeight = parseImportNumber(get('beginningWeight', 'beg weight', 'current weight'));
    const weightPerRoll = parseImportNumber(get('weightPerRoll', 'weight per roll')) || (beginningRolls ? beginningWeight / beginningRolls : 0);
    const currentWeight = beginningWeight || beginningRolls * weightPerRoll;
    return normalizeItemShape({
      id: `QR-${String(state.nextItemNumber++).padStart(5, '0')}`,
      category,
      product,
      gauge: get('gauge', 'gau'),
      meters: get('meters', 'meters per roll', 'meter per roll', 'm/roll'),
      remarks: get('remarks', 'remark'),
      weightPerRoll,
      currentRolls: beginningRolls,
      currentWeight,
      beginningRolls,
      beginningWeight: currentWeight,
      minRolls: 1
    });
  }).filter(Boolean);
}

function rowsToReportItems(rows) {
  const headerIndex = findHeaderRowIndex(rows, ['productdescription']);
  if (headerIndex < 0) throw new Error('Could not find Product Description header in this file.');
  const headerRow = rows[headerIndex].map(normalizeHeader);
  const subHeaderRow = (rows[headerIndex + 1] || []).map(normalizeHeader);
  const productIndex = findColumn(headerRow, ['productdescription', 'description', 'product']);
  const gaugeIndex = findColumn(headerRow, ['gauge', 'gau']);
  const metersIndex = findColumn(headerRow, ['metersperroll', 'meterperroll', 'mroll', 'meters']);
  const remarksIndex = findColumn(headerRow, ['remarks', 'remark']);
  const begRollsIndex = findBeginningColumn(headerRow, subHeaderRow, ['noofrolls', 'norolls', 'rolls']);
  const begWeightIndex = findBeginningColumn(headerRow, subHeaderRow, ['equivweight', 'weight']);
  const imported = [];
  let currentCategory = '';

  rows.slice(headerIndex + 1).forEach((row) => {
    const cells = row.map((cell) => String(cell || '').trim());
    const joined = cells.filter(Boolean).join(' ').trim();
    if (!joined) return;
    const first = cells[0] || '';
    let product = productIndex >= 0 ? cells[productIndex] : first;
    if (productIndex === 0 && /^\d+$/.test(product) && cells[1]) {
      product = cells[1];
    }
    if (/^(product description|no\.? of|equiv\.?|gauge|meters)/i.test(joined)) return;
    const categoryMatch = joined.match(/^(?:[IVXLCDM]+\.|\d+\.)\s*(.+)$/i);
    const hasNumbers = cells.some((cell) => parseImportNumber(cell) > 0);
    if (categoryMatch && !hasNumbers) {
      currentCategory = categoryMatch[1].trim();
      return;
    }
    if (!product || product.toUpperCase() === 'TOTAL') return;

    const beginningRolls = begRollsIndex >= 0 ? parseImportNumber(cells[begRollsIndex]) : 0;
    const beginningWeight = begWeightIndex >= 0 ? parseImportNumber(cells[begWeightIndex]) : 0;
    const weightPerRoll = beginningRolls ? beginningWeight / beginningRolls : 0;
    imported.push(normalizeItemShape({
      id: `QR-${String(state.nextItemNumber++).padStart(5, '0')}`,
      category: currentCategory,
      product,
      gauge: gaugeIndex >= 0 ? cells[gaugeIndex] : '',
      meters: metersIndex >= 0 ? cells[metersIndex] : '',
      remarks: remarksIndex >= 0 ? cells[remarksIndex] : '',
      weightPerRoll,
      currentRolls: beginningRolls,
      currentWeight: beginningWeight,
      beginningRolls,
      beginningWeight,
      minRolls: 1
    }));
  });
  return imported;
}

function parseWorkbookRows(buffer) {
  if (!window.XLSX) throw new Error('Excel reader is still loading. Try again in a few seconds.');
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
}

function findHeaderRowIndex(rows, requiredHeaders) {
  return rows.findIndex((row) => {
    const headers = row.map(normalizeHeader);
    return requiredHeaders.every((header) => headers.includes(normalizeHeader(header)));
  });
}

function findColumn(headers, names) {
  return headers.findIndex((header) => names.map(normalizeHeader).includes(header));
}

function findBeginningColumn(headerRow, subHeaderRow, names) {
  const begStart = headerRow.findIndex((header) => header.includes('beginventory') || header.includes('beginninginventory'));
  const start = begStart >= 0 ? begStart : 0;
  for (let index = start; index < subHeaderRow.length; index++) {
    if (index > start + 2 && begStart >= 0) break;
    if (names.map(normalizeHeader).includes(subHeaderRow[index])) return index;
  }
  return findColumn(subHeaderRow, names);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    const next = input[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(value);
      value = '';
    } else if (char === '\n') {
      row.push(value);
      if (row.some((cell) => String(cell).trim())) rows.push(row);
      row = [];
      value = '';
    } else if (char !== '\r') {
      value += char;
    }
  }
  row.push(value);
  if (row.some((cell) => String(cell).trim())) rows.push(row);
  return rows;
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseImportNumber(value) {
  return Number(String(value || '').replace(/,/g, '').trim()) || 0;
}

async function syncClosedWeekToCloud(summary) {
  if (!cloudEnabled) return;
  try {
    await Promise.all(summary.map((row) => cloudPatch('items', 'id', row.item.id, {
      current_rolls: row.endingRolls,
      current_weight: row.endingWeight
    })));
  } catch (error) {
    setSyncStatus('Sync error', 'offline');
    toast(`Week closed locally, but cloud sync failed: ${error.message}`);
  }
}

function exportTransactionsCsv() {
  const headers = ['Timestamp', 'QR ID', 'Product', 'Action', 'Rolls', 'Weight/Roll', 'Total Weight', 'Balance After', 'User'];
  const rows = state.transactions.map((tx) => [tx.timestamp, tx.itemId, tx.product, tx.action, tx.rolls, tx.weightPerRoll, tx.totalWeight, tx.balanceAfter, tx.user || '']);
  downloadText('transactions.csv', [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n'), 'text/csv');
}

function downloadBackup() {
  downloadText(`qr-inventory-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state, null, 2), 'application/json');
}

function restoreBackup(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const restored = JSON.parse(reader.result);
      if (!Array.isArray(restored.items) || !Array.isArray(restored.transactions)) throw new Error('Invalid backup file.');
      state.items = restored.items;
      state.transactions = restored.transactions;
      state.nextItemNumber = restored.nextItemNumber || restored.items.length + 1;
      saveState();
      renderAll();
      toast('Backup restored.');
    } catch (error) {
      toast(error.message);
    }
  };
  reader.readAsText(file);
}

function resetLocalData() {
  if (!confirm('Reset local inventory data to the starter spreadsheet export?')) return;
  if (cloudEnabled && !confirm('This only resets this browser cache. The online database will stay unchanged. Continue?')) return;
  localStorage.removeItem(STORE_KEY);
  const fresh = loadState();
  state.items = fresh.items;
  state.transactions = fresh.transactions;
  state.nextItemNumber = fresh.nextItemNumber;
  saveState();
  renderAll();
  toast('Local data reset.');
}

function getStaffName() {
  return localStorage.getItem(STAFF_KEY) || '';
}

function saveStaffName() {
  const name = el('staffNameInput').value.trim();
  localStorage.setItem(STAFF_KEY, name);
  toast(name ? `Staff name saved: ${name}` : 'Staff name cleared.');
}

function applyHashScan() {
  const match = location.hash.match(/^#scan:(.+)$/);
  if (!match) return;
  showView('scan');
  selectScanValue(decodeURIComponent(match[1]));
}

function legacyQrText(item) {
  return `${item.category}|${item.product}|${item.gauge}|${item.meters}|${item.remarks}|${Number(item.weightPerRoll || 0).toFixed(2)}`;
}

function activeItems() {
  return state.items.filter((item) => !isImportedTotalRow(item));
}

function isImportedTotalRow(item) {
  return String(item.product || '').trim().toUpperCase() === 'TOTAL';
}

function toDbItem(item) {
  return {
    id: item.id,
    category: item.category,
    product: item.product,
    gauge: item.gauge,
    meters: item.meters,
    remarks: item.remarks,
    weight_per_roll: item.weightPerRoll,
    current_rolls: item.currentRolls,
    current_weight: item.currentWeight,
    min_rolls: item.minRolls
  };
}

function normalizeItemShape(item) {
  const currentRolls = Number(item.currentRolls || 0);
  const currentWeight = Number(item.currentWeight || 0);
  return {
    ...item,
    beginningRolls: Number(item.beginningRolls ?? currentRolls),
    beginningWeight: Number(item.beginningWeight ?? currentWeight),
    currentRolls,
    currentWeight,
    minRolls: Number(item.minRolls ?? 1)
  };
}

function fromDbItem(row) {
  return normalizeItemShape({
    id: row.id,
    category: row.category || '',
    product: row.product || '',
    gauge: row.gauge || '',
    meters: row.meters || '',
    remarks: row.remarks || '',
    weightPerRoll: Number(row.weight_per_roll || 0),
    currentRolls: Number(row.current_rolls || 0),
    currentWeight: Number(row.current_weight || 0),
    minRolls: Number(row.min_rolls || 1)
  });
}

function toDbTransaction(tx) {
  return {
    item_id: tx.itemId,
    action: tx.action,
    rolls: tx.rolls,
    weight_per_roll: tx.weightPerRoll,
    total_weight: tx.totalWeight,
    balance_after: tx.balanceAfter,
    user_name: tx.user || ''
  };
}

function fromDbTransaction(row) {
  const item = state.items.find((candidate) => candidate.id === row.item_id) || {};
  return {
    timestamp: row.created_at,
    itemId: row.item_id,
    product: item.product || '',
    action: row.action,
    rolls: Number(row.rolls || 0),
    weightPerRoll: Number(row.weight_per_roll || 0),
    totalWeight: Number(row.total_weight || 0),
    balanceAfter: Number(row.balance_after || 0),
    user: row.user_name || ''
  };
}

function nextItemNumberFromItems(items) {
  return items.reduce((max, item) => {
    const match = String(item.id).match(/^QR-(\d+)$/);
    return match ? Math.max(max, Number(match[1]) + 1) : max;
  }, 1);
}

function reportDescription(item) {
  return [item.product, item.gauge, item.meters, item.remarks].filter(Boolean).join(' | ');
}

function groupBy(rows, keyFn) {
  const map = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return map;
}

function toDateInput(date) {
  return date.toISOString().slice(0, 10);
}

function formatShortDate(value) {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function downloadText(filename, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function toast(message) {
  const box = el('toast');
  box.textContent = message;
  box.classList.add('show');
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => box.classList.remove('show'), 3200);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

function formatNumber(value, decimals) {
  return Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function formatBlankZero(value, decimals) {
  const number = Number(value || 0);
  return number === 0 ? '' : formatNumber(number, decimals);
}

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString();
}
