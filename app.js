const STORE_KEY = 'qrInventoryApp:v1';
const STAFF_KEY = 'qrInventoryApp:staffName';
const SUPABASE = window.SUPABASE_CONFIG || null;

const state = loadState();
const el = (id) => document.getElementById(id);
const jobOrders = () => window.JOB_ORDERS || [];

const viewMeta = {
  dashboard: ['Dashboard', 'Live stock summary and recent movement'],
  scan: ['Scan', 'Post IN and OUT transactions from QR codes'],
  inventory: ['Inventory', 'Manage rolls, weights, and stock status'],
  transactions: ['Transactions', 'Audit trail of all movement'],
  reports: ['Reports', 'Weekly inventory report and closing'],
  labels: ['QR Labels', 'Print one QR label per roll'],
  settings: ['Settings', 'Backup, restore, and local data controls']
};

let selectedItem = null;
let selectedRollQrId = '';
let selectedRollWeight = null;
let selectedIncomingLabel = null;
let scanStream = null;
let scanTimer = null;
let scanAnimation = null;
let cloudEnabled = false;
let cloudLastError = '';
let labelPrintOnlyIds = null;
let palletLabelEntries = null;

document.addEventListener('DOMContentLoaded', async () => {
  bindNavigation();
  bindActions();
  await initCloud();
  registerLegacyPalletQrAliases();
  palletLabelEntries = (state.rollLabels || []).map((label) => ({ ...label }));
  if (!palletLabelEntries.length) palletLabelEntries = null;
  applyHashScan();
  renderAll();
});

window.addEventListener('hashchange', applyHashScan);

function loadState() {
  const saved = localStorage.getItem(STORE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      parsed.rollLabels = parsed.rollLabels || [];
      parsed.transactions = (parsed.transactions || []).map((tx) => ({
        ...tx,
        localId: tx.localId || createLocalTransactionId()
      }));
      return parsed;
    } catch {
      localStorage.removeItem(STORE_KEY);
    }
  }

  return {
    items: (window.STARTER_ITEMS || []).map((item) => normalizeItemShape(item)),
    rollLabels: [],
    transactions: (window.STARTER_TRANSACTIONS || []).map((tx) => ({
      ...tx,
      localId: tx.localId || createLocalTransactionId()
    })),
    closedWeeks: [],
    nextItemNumber: (window.STARTER_ITEMS || []).length + 1
  };
}

function createLocalTransactionId() {
  return window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function saveState() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

async function initCloud() {
  if (!SUPABASE?.url || !SUPABASE?.key) {
    cloudLastError = 'Missing Supabase URL or publishable key in config.js.';
    setSyncStatus('Local mode', 'offline');
    updateCloudErrorText();
    return;
  }

  try {
    setSyncStatus('Connecting to Supabase...', '');
    cloudLastError = '';
    updateCloudErrorText();
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
    updateCloudErrorText();
  } catch (error) {
    cloudEnabled = false;
    cloudLastError = error.message || String(error);
    setSyncStatus('Offline/local fallback', 'offline');
    updateCloudErrorText();
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

async function cloudDelete(table, idColumn, idValue) {
  const response = await fetch(`${SUPABASE.url}/rest/v1/${table}?${idColumn}=eq.${encodeURIComponent(idValue)}`, {
    method: 'DELETE',
    headers: { ...cloudHeaders(), Prefer: 'return=representation' }
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

function updateCloudErrorText() {
  const text = el('cloudErrorText');
  if (!text) return;
  if (cloudEnabled) {
    text.textContent = 'Online database connected.';
  } else if (cloudLastError) {
    text.textContent = `Last error: ${cloudLastError}`;
  } else {
    text.textContent = 'Use this if the app says Offline/local fallback.';
  }
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
  el('labelSearch').addEventListener('input', () => {
    labelPrintOnlyIds = null;
    renderLabels();
  });
  el('applyReportBtn').addEventListener('click', renderReports);
  el('reportCategoryFilter').addEventListener('change', renderReports);
  el('joUsageSearch').addEventListener('input', renderJobOrderUsageReport);
  el('exportJoUsageBtn').addEventListener('click', exportJobOrderUsageCsv);
  el('printReportBtn').addEventListener('click', () => printMode('report'));
  el('closeWeekBtn').addEventListener('click', closeWeek);
  el('printBtn').addEventListener('click', () => printMode('labels'));
  el('exportBtn').addEventListener('click', exportTransactionsCsv);
  el('backupBtn').addEventListener('click', downloadBackup);
  el('downloadBackupBtn').addEventListener('click', downloadBackup);
  el('restoreInput').addEventListener('change', restoreBackup);
  el('retryCloudBtn').addEventListener('click', retryCloudConnection);
  el('downloadItemTemplateBtn').addEventListener('click', downloadItemTemplate);
  el('itemImportInput').addEventListener('change', importItemsCsv);
  el('resetBtn').addEventListener('click', resetLocalData);
  el('saveStaffBtn').addEventListener('click', saveStaffName);
  el('addItemBtn').addEventListener('click', () => el('itemDialog').showModal());
  el('cancelItemBtn').addEventListener('click', () => el('itemDialog').close());
  el('itemForm').addEventListener('submit', saveNewItem);
  initializeReportDates();
  el('staffNameInput').value = getStaffName();
  updateCloudErrorText();
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
  renderJobOrderOptions();
  renderDashboard();
  renderInventory();
  renderTransactions();
  renderReports();
  renderJobOrderUsageReport();
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

function renderJobOrderOptions() {
  const list = el('jobOrderOptions');
  if (!list) return;
  list.innerHTML = jobOrders().map((job) => {
    const label = [job.joNo, job.customer, job.particulars, job.size].filter(Boolean).join(' - ');
    return `<option value="${escapeHtml(job.joNo)}" label="${escapeHtml(label)}"></option>`;
  }).join('');
}

function renderDashboard() {
  const items = activeItems();
  const totalRolls = items.reduce((sum, item) => {
    const movement = getItemMovement(item.id);
    return sum + Number(item.beginningRolls || 0) + movement.inRolls - movement.outRolls;
  }, 0);
  const totalWeight = items.reduce((sum, item) => {
    const movement = getItemMovement(item.id);
    return sum + Math.max(0, Number(item.beginningWeight || 0) + movement.inWeight - movement.outWeight);
  }, 0);
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
      <td>${escapeHtml(tx.rollQrId || palletQrIdFor(item))}</td>
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
      <td>${escapeHtml(palletQrIdFor(item))}</td>
      <td>${escapeHtml(item.category)}</td>
      <td>${escapeHtml(item.product)}</td>
      <td>${escapeHtml(item.gauge)}</td>
      <td>${escapeHtml(item.meters)}</td>
      <td>${escapeHtml(displayRemarks(item))}</td>
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
    .filter((tx) => resolveInventoryItemId(tx.itemId) === itemId)
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
    const text = `${tx.itemId} ${item.product || tx.product || ''} ${tx.action} ${tx.issuedFor || ''} ${tx.user || ''}`.toLowerCase();
    return (!query || text.includes(query)) && (!action || tx.action === action);
  }).slice().reverse();

  el('transactionRows').innerHTML = rows.map((tx) => {
    const item = state.items.find((row) => row.id === tx.itemId) || {};
    const isLatestForItem = state.transactions.findLastIndex((other) => other.itemId === tx.itemId) === state.transactions.indexOf(tx);
    return `<tr>
      <td>${formatDate(tx.timestamp)}</td>
      <td>${escapeHtml(tx.rollQrId || palletQrIdFor(item))}</td>
      <td>${escapeHtml(item.product || tx.product || '')}</td>
      <td><span class="pill ${tx.action.toLowerCase()}">${tx.action}</span></td>
      <td>${formatNumber(tx.rolls, 0)}</td>
      <td>${formatNumber(tx.weightPerRoll, 2)}</td>
      <td>${formatNumber(tx.totalWeight, 2)}</td>
      <td>${formatNumber(tx.balanceAfter, 0)}</td>
      <td>${escapeHtml(tx.issuedFor || '')}</td>
      <td>${escapeHtml(tx.user || '')}</td>
      <td>${isLatestForItem ? `<button class="danger void-transaction-btn" data-tx-id="${escapeHtml(tx.localId)}" title="Void this latest transaction">Void</button>` : ''}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="11">No transactions yet.</td></tr>`;
  el('transactionRows').querySelectorAll('.void-transaction-btn').forEach((button) => {
    button.addEventListener('click', () => voidTransaction(button.dataset.txId));
  });
}

async function voidTransaction(localId) {
  const index = state.transactions.findIndex((tx) => tx.localId === localId);
  if (index < 0) return;
  const tx = state.transactions[index];
  const hasLaterMovement = state.transactions.findLastIndex((other) => other.itemId === tx.itemId) !== index;
  if (hasLaterMovement) {
    toast('This is no longer the latest movement for that QR and cannot be voided.');
    return;
  }
  if (!confirm(`Permanently void this ${tx.action === 'IN' ? 'Delivery' : 'Issuance'} of ${tx.rolls} roll(s) for ${tx.itemId}? The stock balance will be recalculated. This cannot be undone.`)) return;

  if (cloudEnabled) {
    if (tx.dbId != null) {
      try {
        await cloudDelete('transactions', 'id', tx.dbId);
      } catch (error) {
        toast(`Could not void online transaction: ${error.message}`);
        return;
      }
    }
  }

  state.transactions.splice(index, 1);
  const item = state.items.find((row) => row.id === resolveInventoryItemId(tx.itemId));
  if (item) {
    const movement = getItemMovement(item.id);
    item.currentRolls = Number(item.beginningRolls || 0) + movement.inRolls - movement.outRolls;
    item.currentWeight = Math.max(0, Number(item.beginningWeight || 0) + movement.inWeight - movement.outWeight);
    if (cloudEnabled) {
      try {
        await cloudPatch('items', 'id', item.id, {
          current_rolls: item.currentRolls,
          current_weight: item.currentWeight
        });
      } catch (error) {
        toast(`Transaction voided, but item balance sync failed: ${error.message}`);
      }
    }
  }
  saveState();
  renderAll();
  toast('Transaction voided and stock recalculated.');
}

async function receiveIncomingRoll() {
  if (!selectedIncomingLabel) return;
  const label = selectedIncomingLabel;
  let item = selectedItem || findMasterForIncoming(label);
  if (!item) {
    item = normalizeItemShape({
      id: `QR-${String(state.nextItemNumber || nextItemNumberFromItems(state.items)).padStart(5, '0')}`,
      category: label.category,
      product: label.product,
      gauge: label.gauge,
      meters: label.meters,
      remarks: label.remarks,
      weightPerRoll: label.weightPerRoll,
      beginningRolls: 0,
      beginningWeight: 0,
      currentRolls: 0,
      currentWeight: 0,
      minRolls: 1
    });
    state.nextItemNumber = Number(item.id.match(/\d+$/)?.[0] || 0) + 1;
    state.items.push(item);
    await syncNewItemToCloud(item);
  }

  const savedLabelIndex = (state.rollLabels || []).findIndex((row) => row.qrId === label.qrId);
  const savedLabel = { ...label, itemId: item.id, delivered: true };
  if (savedLabelIndex >= 0) state.rollLabels[savedLabelIndex] = savedLabel;
  else state.rollLabels.push(savedLabel);
  selectedItem = item;
  selectedRollQrId = label.qrId;
  selectedRollWeight = Number(label.weightPerRoll);
  selectedIncomingLabel = null;
  saveState();
  renderScanResult();
  const userField = document.getElementById('actionUser');
  if (userField) userField.value = document.getElementById('incomingDeliveryUser')?.value.trim() || getStaffName();
  postTransaction('IN');
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
    html.push(`<tr class="category-row"><td colspan="9">${romanNumeral(categoryNumber++)}. ${escapeHtml(category)}</td></tr>`);
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
        <td>${reportNumber++}</td>
        <td>${escapeHtml(row.item.product)}</td>
        <td>${escapeHtml(row.item.gauge)}</td>
        <td>${escapeHtml(row.item.meters)}</td>
        <td>${escapeHtml(row.item.remarks)}</td>
        <td>${formatRollWeight(row.beginningRolls, row.beginningWeight)}</td>
        <td>${formatRollWeight(row.inRolls, row.inWeight)}</td>
        <td>${formatRollWeight(row.outRolls, row.outWeight)}</td>
        <td>${formatRollWeight(row.endingRolls, row.endingWeight)}</td>
      </tr>`);
    });
    html.push(reportCategoryTotalRow(category, total));
  }
  el('reportRows').innerHTML = html.join('') || `<tr><td colspan="9">No inventory rows.</td></tr>`;
  renderJobOrderUsageReport();
  renderClosedWeeks();
}

function renderJobOrderUsageReport() {
  const rows = buildJobOrderUsageRows();
  const html = [];
  let grandRolls = 0;
  let grandWeight = 0;

  for (const [issuedFor, txRows] of groupBy(rows, (row) => row.jobNo || row.issuedFor).entries()) {
    const totalRolls = txRows.reduce((sum, row) => sum + Number(row.rolls || 0), 0);
    const totalWeight = txRows.reduce((sum, row) => sum + Number(row.totalWeight || 0), 0);
    const firstRow = txRows[0] || {};
    const groupLabel = [
      issuedFor,
      firstRow.customer,
      firstRow.jobParticulars
    ].filter(Boolean).join(' - ');
    grandRolls += totalRolls;
    grandWeight += totalWeight;
    html.push(`<tr class="category-row"><td colspan="14">${escapeHtml(groupLabel)} - ${formatNumber(totalRolls, 0)} roll(s) / ${formatNumber(totalWeight, 2)} kg</td></tr>`);
    txRows.forEach((row) => {
      html.push(`<tr>
        <td>${escapeHtml(row.jobNo || row.issuedFor)}</td>
        <td>${escapeHtml(row.customer)}</td>
        <td>${escapeHtml(row.jobParticulars)}</td>
        <td>${escapeHtml(row.jobSize)}</td>
        <td>${formatDate(row.timestamp)}</td>
        <td>${escapeHtml(row.itemId)}</td>
        <td>${escapeHtml(row.category)}</td>
        <td>${escapeHtml(row.product)}</td>
        <td>${escapeHtml(row.gauge)}</td>
        <td>${escapeHtml(row.meters)}</td>
        <td>${escapeHtml(displayRemarks(row))}</td>
        <td>${formatNumber(row.rolls, 0)}</td>
        <td>${formatNumber(row.totalWeight, 2)}</td>
        <td>${escapeHtml(row.user || '')}</td>
      </tr>`);
    });
  }

  if (html.length) {
    html.push(`<tr class="total-row"><td colspan="11">GRAND TOTAL</td><td>${formatNumber(grandRolls, 0)}</td><td>${formatNumber(grandWeight, 2)}</td><td></td></tr>`);
  }

  el('joUsageRows').innerHTML = html.join('') || `<tr><td colspan="14">No issued rolls with JO / Issued For for this period.</td></tr>`;
}

function buildJobOrderUsageRows() {
  const from = el('reportFrom').value;
  const to = el('reportTo').value;
  const query = (el('joUsageSearch')?.value || '').trim().toLowerCase();
  const fromDate = from ? new Date(`${from}T00:00:00`) : null;
  const toDate = to ? new Date(`${to}T23:59:59`) : null;

  return state.transactions
    .filter((tx) => {
      const date = new Date(tx.timestamp);
      return tx.action === 'OUT'
        && String(tx.issuedFor || '').trim()
        && (!fromDate || date >= fromDate)
        && (!toDate || date <= toDate);
    })
    .map((tx) => {
      const item = state.items.find((row) => row.id === tx.itemId) || {};
      const issuedFor = String(tx.issuedFor || '').trim();
      const job = findJobOrder(issuedFor);
      return {
        ...tx,
        issuedFor,
        jobNo: job?.joNo || extractJobOrderNo(issuedFor),
        customer: job?.customer || '',
        jobParticulars: job?.particulars || '',
        jobSize: job?.size || '',
        category: item.category || '',
        product: item.product || tx.product || '',
        gauge: item.gauge || '',
        meters: item.meters || '',
        remarks: item.remarks || ''
      };
    })
    .filter((row) => {
      const text = `${row.issuedFor} ${row.jobNo} ${row.customer} ${row.jobParticulars} ${row.jobSize} ${row.itemId} ${row.category} ${row.product} ${row.gauge} ${row.meters} ${row.remarks} ${row.user || ''}`.toLowerCase();
      return !query || text.includes(query);
    })
    .sort((a, b) => (a.jobNo || a.issuedFor).localeCompare(b.jobNo || b.issuedFor) || new Date(a.timestamp) - new Date(b.timestamp));
}

function extractJobOrderNo(value) {
  const text = String(value || '').trim();
  const match = text.match(/\b\d{3}-[A-Z]-\d{3}\b/i);
  return match ? match[0].toUpperCase() : text.toUpperCase();
}

function findJobOrder(value) {
  const key = extractJobOrderNo(value);
  if (!key) return null;
  return jobOrders().find((job) => String(job.joNo || '').toUpperCase() === key) || null;
}

function jobOrderSummary(value) {
  const job = findJobOrder(value);
  if (!job) return '';
  return [
    `Customer: ${job.customer || '-'}`,
    `Particulars: ${job.particulars || '-'}`,
    `Size: ${job.size || '-'}`
  ].join(' | ');
}

function updateJobOrderPreview() {
  const input = el('issuedForInput');
  const preview = el('jobOrderPreview');
  if (!input || !preview) return;
  const summary = jobOrderSummary(input.value);
  preview.textContent = summary || 'No matching job order yet.';
  preview.classList.toggle('matched', Boolean(summary));
}

function reportCategoryTotalRow(category, total) {
  return `<tr class="total-row">
    <td></td>
    <td>${escapeHtml(category)} TOTAL</td>
    <td></td>
    <td></td>
    <td></td>
    <td>${formatRollWeight(total.beginningRolls, total.beginningWeight)}</td>
    <td>${formatRollWeight(total.inRolls, total.inWeight)}</td>
    <td>${formatRollWeight(total.outRolls, total.outWeight)}</td>
    <td>${formatRollWeight(total.endingRolls, total.endingWeight)}</td>
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
      return resolveInventoryItemId(tx.itemId) === item.id && (!fromDate || txDate >= fromDate) && (!toDate || txDate <= toDate);
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

function palletMetadata(item) {
  return null;
}

function palletQrIdFor(item) {
  return item.id;
}

function displayRemarks(item) {
  return item.remarks || '';
}

function palletLabelGroups(sourceItems = activeItems()) {
  return sourceItems.map((item) => ({ palletNo: '', items: [item] }));
}

function palletContentsFor(item) {
  return [item];
}

function renderLabels() {
  const query = el('labelSearch').value.trim().toLowerCase();
  if (palletLabelEntries) {
    const labels = palletLabelEntries.filter((label) => {
      const searchable = [label.qrId, label.itemId, label.category, label.product, label.gauge, label.meters, label.palletNo, label.rollNumber].join(' ').toLowerCase();
      return !query || searchable.includes(query);
    });
    el('labelGrid').innerHTML = labels.map((label) => {
      const payloadData = {
        qrId: label.qrId,
        itemId: label.itemId || '',
        category: label.category,
        product: label.product,
        gauge: label.gauge,
        meters: label.meters,
        remarks: label.remarks,
        weightPerRoll: label.weightPerRoll,
        palletNo: label.palletNo,
        rollNumber: label.rollNumber,
        totalRolls: label.totalRolls
      };
      const payload = (window.APP_BASE_URL || (location.origin + location.pathname)) + '#incoming:' + encodeURIComponent(JSON.stringify(payloadData));
      const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=' + encodeURIComponent(payload);
      return '<div class="qr-label"><img src="' + qrUrl + '" alt="QR for ' + escapeHtml(label.qrId) + '"><div>' +
        '<strong>' + escapeHtml(label.qrId) + '</strong>' +
        '<span>' + escapeHtml(label.category + ' · ' + label.product + ' · ' + label.gauge + ' · ' + label.meters + 'm') + '</span>' +
        '<span>Pallet ' + escapeHtml(label.palletNo) + ' · Roll ' + label.rollNumber + ' of ' + label.totalRolls + '</span>' +
        '<span>Estimated ' + formatNumber(label.weightPerRoll, 2) + ' kg/roll</span>' +
        '</div></div>';
    }).join('');
    return;
  }
  const groups = palletLabelGroups().filter((group) => {
    const master = group.items[0];
    if (labelPrintOnlyIds && !labelPrintOnlyIds.includes(master.id)) return false;
    const text = [group.palletNo, ...group.items.flatMap((item) => [
      item.id, item.category, item.product, item.gauge, item.meters, item.remarks
    ])].join(' ').toLowerCase();
    return !query || text.includes(query);
  });

  el('labelGrid').innerHTML = groups.map((group) => {
    const master = group.items[0];
    const payload = (window.APP_BASE_URL || (location.origin + location.pathname)) + '#scan:' + encodeURIComponent(master.id);
    const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=' + encodeURIComponent(payload);
    const title = group.palletNo ? 'Pallet ' + group.palletNo : master.id;
    const contents = group.items.map((item) => {
      const type = String(item.remarks || '').split('|').pop().trim();
      return '<span>' + escapeHtml(item.category + ' · ' + item.product + ' · ' + item.gauge + ' · ' + item.meters + 'm · ' + type + ' · 1 roll · est. ' + formatNumber(item.weightPerRoll, 2) + ' kg') + '</span>';
    }).join('');
    return '<div class="qr-label"><img src="' + qrUrl + '" alt="QR for ' + escapeHtml(title) + '"><div>' +
      '<strong>' + escapeHtml(title) + '</strong>' +
      '<span>QR ID: ' + escapeHtml(master.id) + '</span>' + contents +
      '</div></div>';
  }).join('');
}

function selectScanValue(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) {
    toast('Enter or scan a QR value.');
    return;
  }

  const scanDetails = qrScanDetails(value);
  const item = findItem(value);
  selectedRollQrId = scanDetails.rollQrId;
  selectedRollWeight = scanDetails.weightPerRoll;
  selectedIncomingLabel = scanDetails.incomingLabel;
  if (!item && !selectedIncomingLabel) {
    selectedItem = null;
    renderScanResult();
    toast('QR not found in inventory.');
    return;
  }

  selectedItem = item;
  el('scanInput').value = selectedRollQrId || item?.id || selectedIncomingLabel.qrId;
  renderScanResult();
}

function qrScanDetails(value) {
  const decoded = decodeURIComponent(String(value || '').trim());
  const incoming = decoded.match(/#incoming:(.+)$/);
  if (incoming) {
    const metadata = JSON.parse(incoming[1]);
    const savedLabel = state.rollLabels?.find((label) => label.qrId === metadata.qrId);
    const merged = { ...metadata, ...savedLabel, qrId: metadata.qrId };
    return {
      itemId: merged.itemId || findMasterForIncoming(merged)?.id || '',
      rollQrId: merged.qrId,
      weightPerRoll: Number(merged.weightPerRoll),
      incomingLabel: merged.delivered ? null : merged
    };
  }
  const hash = decoded.match(/#scan:([^#]+)/);
  const queryId = decoded.match(/(?:^|[?&])id=([^&#]+)/);
  const token = hash ? hash[1] : queryId ? queryId[1] : decoded;
  const [tokenId, ...parts] = token.split('|');
  const savedLabel = state.rollLabels?.find((label) => label.qrId.toLowerCase() === tokenId.toLowerCase());
  if (!hash && !queryId && !savedLabel) return { itemId: decoded, rollQrId: '', weightPerRoll: null };
  const weightText = parts.find((part) => part.startsWith('weight='))?.slice(7);
  return {
    itemId: parts.find((part) => part.startsWith('item='))?.slice(5) || savedLabel?.itemId || tokenId,
    rollQrId: parts.find((part) => part.startsWith('roll='))?.slice(5) || savedLabel?.qrId || '',
    weightPerRoll: weightText == null ? (savedLabel ? Number(savedLabel.weightPerRoll) : null) : Number(weightText),
    incomingLabel: savedLabel || null
  };
}

function findItem(value) {
  const details = qrScanDetails(value);
  const normalized = details.itemId.trim();
  if (!normalized && details.incomingLabel) return findMasterForIncoming(details.incomingLabel);

  return activeItems().find((item) => item.id.toLowerCase() === normalized.toLowerCase())
    || activeItems().find((item) => legacyQrText(item).toLowerCase() === normalized.toLowerCase());
}

function findMasterForIncoming(label) {
  const width = String(label.product || '').match(/^\s*([\d.]+)\s*mm\b/i)?.[1];
  return activeItems().filter((item) => {
    const itemWidth = String(item.product || '').match(/^\s*([\d.]+)\s*mm\b/i)?.[1];
    return String(item.category).toLowerCase() === String(label.category).toLowerCase() &&
      Number(itemWidth) === Number(width) && Number(item.gauge) === Number(label.gauge) &&
      Number(String(item.meters).replace(/,/g, '')) === Number(label.meters);
  }).sort((a, b) => Number(a.id.match(/\d+/)?.[0] || 0) - Number(b.id.match(/\d+/)?.[0] || 0))[0] || null;
}

function resolveInventoryItemId(itemId) {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item || !isLegacyPalletRollItem(item)) return itemId;
  return findMasterForIncoming(item)?.id || itemId;
}

function renderScanResult() {
  const panel = el('scanResult');
  if (selectedIncomingLabel && !selectedIncomingLabel.delivered) {
    panel.className = 'item-panel';
    panel.innerHTML = `<h2>${escapeHtml(selectedIncomingLabel.product)} incoming roll</h2>
      <p>${escapeHtml(selectedIncomingLabel.category)} · Roll QR ${escapeHtml(selectedIncomingLabel.qrId)} · Not yet received</p>
      <div class="item-detail">
        <div class="detail-box"><span>Inventory Match</span><strong>${selectedItem ? escapeHtml(selectedItem.id) : 'Will create item on delivery'}</strong></div>
        <div class="detail-box"><span>Gauge</span><strong>${escapeHtml(selectedIncomingLabel.gauge)}</strong></div>
        <div class="detail-box"><span>Meters/Roll</span><strong>${escapeHtml(selectedIncomingLabel.meters)}</strong></div>
        <div class="detail-box"><span>Pallet / Roll</span><strong>${escapeHtml(selectedIncomingLabel.palletNo)} / ${selectedIncomingLabel.rollNumber}</strong></div>
        <div class="detail-box"><span>Estimated Weight/Roll</span><strong>${formatNumber(selectedIncomingLabel.weightPerRoll, 2)} kg</strong></div>
      </div>
      <div class="action-form"><label>Scanned By<input id="incomingDeliveryUser" value="${escapeHtml(getStaffName())}" placeholder="Name or initials"></label>
        <button class="primary" id="receiveIncomingRollBtn">Delivery</button></div>`;
    document.getElementById('receiveIncomingRollBtn').addEventListener('click', receiveIncomingRoll);
    return;
  }
  if (!selectedItem) {
    panel.className = 'item-panel empty';
    panel.innerHTML = '<div><h2>No item selected</h2><p>Scan or enter a QR ID to begin.</p></div>';
    return;
  }

  const palletMeta = palletMetadata(selectedItem);
  const palletItems = palletContentsFor(selectedItem);
  const palletPicker = palletItems.length > 1
    ? '<div class="pallet-content-picker"><strong>Select a size / film</strong><div>' + palletItems.map((item) =>
      '<button type="button" class="pallet-content-choice' + (item.id === selectedItem.id ? ' active' : '') + '" data-item-id="' + escapeHtml(item.id) + '">' +
      escapeHtml(item.category + ' · ' + item.product + ' · ' + item.gauge + ' · ' + item.meters + 'm · ' + formatNumber(item.currentRolls, 0) + ' rolls') +
      '</button>'
    ).join('') + '</div></div>'
    : '';
  panel.className = 'item-panel';
  panel.innerHTML = `
    <h2>${escapeHtml(palletMeta ? 'Pallet ' + palletMeta.palletNo : selectedItem.product)}</h2>
    <p>${palletMeta ? palletItems.length + ' size entries' : escapeHtml(selectedItem.category)} · Inventory ${escapeHtml(palletQrIdFor(selectedItem))}${selectedRollQrId ? ' · Roll QR ' + escapeHtml(selectedRollQrId) : ''}</p>
    ${palletPicker}
    <div class="item-detail">
      <div class="detail-box"><span>Gauge</span><strong>${escapeHtml(selectedItem.gauge)}</strong></div>
      <div class="detail-box"><span>Meters/Roll</span><strong>${escapeHtml(selectedItem.meters)}</strong></div>
      <div class="detail-box"><span>Remarks</span><strong>${escapeHtml(displayRemarks(selectedItem))}</strong></div>
      <div class="detail-box"><span>Available Rolls</span><strong>${formatNumber(selectedItem.currentRolls, 0)}</strong></div>
      <div class="detail-box"><span>Available Weight</span><strong>${formatNumber(selectedItem.currentWeight, 2)}</strong></div>
      <div class="detail-box"><span>Weight/Roll</span><strong>${formatNumber(selectedItem.weightPerRoll, 2)}</strong></div>
    </div>
    <div class="action-form">
      <label>Rolls<input id="actionRolls" type="number" min="1" step="1" value="1"></label>
      <label>Scanned By<input id="actionUser" placeholder="Name or initials" value="${escapeHtml(getStaffName())}"></label>
      <label class="wide">Issued For / Job Order<input id="issuedForInput" list="jobOrderOptions" placeholder="Example: 026-A-010"><small id="jobOrderPreview" class="field-note">No matching job order yet.</small></label>
      <button class="primary" id="postInBtn">Delivery</button>
      <button class="danger" id="postOutBtn">Issuance</button>
    </div>
  `;

  panel.querySelectorAll('.pallet-content-choice').forEach((button) => {
    button.addEventListener('click', () => {
      selectedItem = findItem(button.dataset.itemId);
      renderScanResult();
    });
  });
  document.getElementById('issuedForInput').addEventListener('input', updateJobOrderPreview);
  document.getElementById('postInBtn').addEventListener('click', () => postTransaction('IN'));
  document.getElementById('postOutBtn').addEventListener('click', () => postTransaction('OUT'));
  updateJobOrderPreview();
}

function postTransaction(action) {
  if (!selectedItem) return;
  const rolls = Number(document.getElementById('actionRolls').value);
  const user = document.getElementById('actionUser').value.trim();
  let issuedFor = action === 'OUT' ? document.getElementById('issuedForInput').value.trim() : '';
  const actionLabel = action === 'IN' ? 'DELIVERY' : 'ISSUANCE';

  if (!Number.isFinite(rolls) || rolls <= 0) {
    toast('Enter a valid roll quantity.');
    return;
  }
  if (action === 'OUT' && rolls > Number(selectedItem.currentRolls || 0)) {
    toast(`Blocked: only ${formatNumber(selectedItem.currentRolls, 0)} roll(s) available.`);
    return;
  }
  if (action === 'OUT' && !issuedFor) {
    issuedFor = prompt('Issued for / Job Order?', jobOrders()[0]?.joNo || '026-A-010')?.trim() || '';
    if (issuedFor) {
      document.getElementById('issuedForInput').value = issuedFor;
      updateJobOrderPreview();
    } else {
      toast('Enter Issued For / Job Order before posting issuance.');
      return;
    }
  }
  const matchedJob = findJobOrder(issuedFor);
  if (matchedJob) {
    issuedFor = matchedJob.joNo;
  }

  const weightPerRoll = Number(selectedRollWeight ?? selectedItem.weightPerRoll ?? 0);
  const totalWeight = rolls * weightPerRoll;
  const signedRolls = action === 'IN' ? rolls : -rolls;
  const signedWeight = action === 'IN' ? totalWeight : -totalWeight;
  selectedItem.currentRolls = Number(selectedItem.currentRolls || 0) + signedRolls;
  selectedItem.currentWeight = Math.max(0, Number(selectedItem.currentWeight || 0) + signedWeight);

  state.transactions.push({
    localId: createLocalTransactionId(),
    rollQrId: selectedRollQrId,
    timestamp: new Date().toISOString(),
    itemId: selectedItem.id,
    product: selectedItem.product,
    action,
    rolls,
    weightPerRoll,
    totalWeight,
    balanceAfter: selectedItem.currentRolls,
    issuedFor,
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
    try {
      const inserted = await cloudInsert('transactions', [toDbTransaction(transaction)]);
      transaction.dbId = inserted[0]?.id;
    } catch (error) {
      if (!String(error.message || error).toLowerCase().includes('issued_for')) throw error;
      const row = toDbTransaction(transaction);
      delete row.issued_for;
      const inserted = await cloudInsert('transactions', [row]);
      transaction.dbId = inserted[0]?.id;
      toast('Saved online without Issued For. Add the issued_for column in Supabase to sync this field.');
    }
    await cloudPatch('items', 'id', item.id, {
      current_rolls: item.currentRolls,
      current_weight: item.currentWeight
    });
    saveState();
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

async function saveNewItem(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const weightPerRoll = Number(form.get('weightPerRoll') || 0);
  const currentRolls = 1;
  const item = {
    id: `QR-${String(state.nextItemNumber++).padStart(5, '0')}`,
    category: form.get('category').trim(),
    product: form.get('product').trim(),
    gauge: form.get('gauge').trim(),
    meters: form.get('meters').trim(),
    remarks: form.get('remarks').trim(),
    weightPerRoll,
    beginningRolls: 0,
    beginningWeight: 0,
    currentRolls: 0,
    currentWeight: 0,
    minRolls: 1
  };
  state.items.push(item);
  saveState();
  await syncNewItemToCloud(item);

  const totalWeight = currentRolls * weightPerRoll;
  item.currentRolls = currentRolls;
  item.currentWeight = totalWeight;
  const transaction = {
    localId: createLocalTransactionId(),
    timestamp: new Date().toISOString(),
    itemId: item.id,
    product: item.product,
    action: 'IN',
    rolls: currentRolls,
    weightPerRoll,
    totalWeight,
    balanceAfter: currentRolls,
    issuedFor: '',
    user: getStaffName()
  };
  state.transactions.push(transaction);
  saveState();
  await syncTransactionToCloud(item, transaction);

  event.currentTarget.reset();
  el('itemDialog').close();
  renderAll();
  showView('labels');
  labelPrintOnlyIds = [item.id];
  el('labelSearch').value = item.id;
  renderLabels();
  toast(`Delivery recorded. Print and attach QR ${item.id} to this pallet.`);
  printMode('labels');
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

async function syncPalletReceiptsToCloud(items, transactions) {
  if (!cloudEnabled) return;
  try {
    await cloudInsert('items', items.map(toDbItem));
    if (transactions.length) await cloudInsert('transactions', transactions.map(toDbTransaction));
    setSyncStatus('Online database connected', 'online');
  } catch (error) {
    setSyncStatus('Sync error', 'offline');
    toast(`Pallets saved on this device, but online sync failed: ${error.message}`);
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
      if (findPalletListHeaderIndex(rows) >= 0) {
        const receipts = rowsToPalletReceipts(rows);
        if (!receipts.labels.length) throw new Error('No pallet rows with valid roll count and net weight were found.');
        const totalRolls = receipts.labels.length;
        const totalWeight = receipts.labels.reduce((sum, label) => sum + label.weightPerRoll, 0);
        const approved = confirm(
          `Prepare ${totalRolls} roll labels from ${receipts.sourceLineCount} pallet size rows?\n\n` +
          `${totalRolls} rolls\n${formatNumber(totalWeight, 2)} kg total\n\n` +
          'This creates QR labels only; it does NOT create inventory items or add stock. When a roll arrives, scan its label and choose Delivery. It will go to a matching category/size item, or create one item then if none exists. Weights are estimated averages; individual batch numbers are not in this file.'
        );
        if (!approved) return;

        state.items.push(...receipts.items);
        state.rollLabels = state.rollLabels || [];
        const existingLabelIds = new Set(state.rollLabels.map((label) => label.qrId));
        state.rollLabels.push(...receipts.labels.filter((label) => !existingLabelIds.has(label.qrId)).map(({ item, ...label }) => label));
        state.nextItemNumber = Math.max(receipts.nextNumber, nextItemNumberFromItems(state.items));
        saveState();
        await syncNewItemsToCloud(receipts.items);
        palletLabelEntries = receipts.labels;
        renderAll();
        showView('labels');
        labelPrintOnlyIds = null;
        el('labelSearch').value = '';
        renderLabels();
        toast(`Prepared ${totalRolls} roll labels linked to inventory items. Print them now; record Delivery when rolls arrive.`);
        return;
      }
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

function findPalletListHeaderIndex(rows) {
  return rows.findIndex((row) => {
    const headers = row.map(normalizeHeader);
    return headers.some((header) => header.includes('palletsno') || header.includes('palletno')) &&
      headers.some((header) => header.includes('description')) &&
      headers.some((header) => header.includes('size')) &&
      headers.some((header) => header.includes('width')) &&
      headers.some((header) => header.includes('weight')) &&
      headers.some((header) => header.includes('rollno'));
  });
}

function rowsToPalletReceipts(rows) {
  const headerIndex = findPalletListHeaderIndex(rows);
  if (headerIndex < 0) return { items: [], transactions: [], sourceLineCount: 0 };
  const headers = rows[headerIndex].map(normalizeHeader);
  const palletIndex = headers.findIndex((header) => header.includes('palletsno') || header.includes('palletno'));
  const descriptionIndex = headers.findIndex((header) => header.includes('description'));
  const sizeIndex = headers.findIndex((header) => header.includes('size'));
  const widthIndex = headers.findIndex((header) => header.includes('width'));
  const weightIndex = headers.findIndex((header) => header.includes('weight'));
  const rollsIndex = headers.findIndex((header) => header.includes('rollno'));
  const entries = [];
  const palletRollTotals = new Map();

  rows.slice(headerIndex + 1).forEach((row) => {
    const palletNo = String(row[palletIndex] ?? '').trim();
    const description = String(row[descriptionIndex] ?? '').trim();
    const size = String(row[sizeIndex] ?? '').trim();
    const width = String(row[widthIndex] ?? '').trim();
    const netWeight = parseImportNumber(row[weightIndex]);
    const rolls = parseImportNumber(row[rollsIndex]);
    if (!palletNo || /total|净重合计/i.test(palletNo)) return;
    if (!description && !size && !width) return;
    if (!description || !size || !width || !netWeight || !Number.isInteger(rolls) || rolls < 1) {
      throw new Error('Pallet ' + palletNo + ' is missing valid description, size, width, net weight, or roll count.');
    }

    const normalizedDescription = description.toUpperCase();
    let category = '';
    if (normalizedDescription.includes('VMCPP')) category = 'VMCPP';
    else if (normalizedDescription.includes('COEX')) category = 'COEX';
    else if (normalizedDescription.includes('CPP')) category = 'CPP';
    else if (normalizedDescription.includes('BOPP')) category = 'BOPP PLAIN';
    if (!category) throw new Error('Pallet ' + palletNo + ' has an unrecognized film type: ' + description + '.');

    const sizeMatch = size.match(/([\d.]+)\s*mic\s*\*\s*([\d,]+)\s*m/i);
    if (!sizeMatch) throw new Error('Could not read gauge and meters from size "' + size + '" on pallet ' + palletNo + '.');
    const remarkMatch = description.match(/\(([^)]+)\)/);
    entries.push({
      palletNo,
      description,
      category,
      width,
      gauge: sizeMatch[1],
      meters: sizeMatch[2].replace(/,/g, ''),
      typeRemark: remarkMatch ? remarkMatch[1] : description,
      netWeight,
      rolls,
      weightPerRoll: netWeight / rolls
    });
    palletRollTotals.set(palletNo, (palletRollTotals.get(palletNo) || 0) + rolls);
  });

  const items = [];
  const labels = [];
  let nextNumber = state.nextItemNumber || nextItemNumberFromItems(state.items);
  const palletRollCounters = new Map();

  entries.forEach((entry) => {
    const master = state.items.filter((item) => {
      const itemWidth = String(item.product || '').match(/^\s*([\d.]+)\s*mm\b/i)?.[1];
      return item.category.toLowerCase() === entry.category.toLowerCase() &&
        Number(itemWidth) === Number(entry.width) &&
        Number(item.gauge) === Number(entry.gauge) &&
        Number(String(item.meters).replace(/,/g, '')) === Number(entry.meters);
    }).sort((a, b) => Number(a.id.match(/\d+/)?.[0] || 0) - Number(b.id.match(/\d+/)?.[0] || 0))[0];
    for (let index = 0; index < entry.rolls; index++) {
      const rollNumber = (palletRollCounters.get(entry.palletNo) || 0) + 1;
      palletRollCounters.set(entry.palletNo, rollNumber);
      const priorLabel = (state.rollLabels || []).find((label) =>
        label.palletNo === entry.palletNo && label.rollNumber === rollNumber &&
        String(label.category).toLowerCase() === entry.category.toLowerCase() &&
        Number(String(label.product).match(/[\d.]+/)?.[0]) === Number(entry.width) &&
        Number(label.gauge) === Number(entry.gauge) && Number(label.meters) === Number(entry.meters) &&
        Number(label.weightPerRoll) === Number(entry.weightPerRoll)
      );
      labels.push({
        itemId: master?.id || '',
        qrId: priorLabel?.qrId || 'QR-' + String(nextNumber++).padStart(5, '0'),
        palletNo: entry.palletNo,
        rollNumber,
        totalRolls: palletRollTotals.get(entry.palletNo),
        weightPerRoll: entry.weightPerRoll,
        category: entry.category,
        product: entry.width + 'mm',
        gauge: entry.gauge,
        meters: entry.meters,
        remarks: entry.typeRemark,
        delivered: false
      });
    }
  });
  return { items, labels, nextNumber, sourceLineCount: entries.length };
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
  const headers = ['Timestamp', 'QR ID', 'Product', 'Action', 'Rolls', 'Weight/Roll', 'Total Weight', 'Balance After', 'Issued For', 'User'];
  const rows = state.transactions.map((tx) => [tx.timestamp, tx.rollQrId || tx.itemId, tx.product, tx.action, tx.rolls, tx.weightPerRoll, tx.totalWeight, tx.balanceAfter, tx.issuedFor || '', tx.user || '']);
  downloadText('transactions.csv', [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n'), 'text/csv');
}

function exportJobOrderUsageCsv() {
  const headers = ['JO / Issued For', 'Customer', 'Job Particulars', 'Job Size', 'Timestamp', 'QR ID', 'Category', 'Product', 'Gauge', 'Meters/Roll', 'Remarks', 'Rolls', 'Total Weight', 'Scanned By'];
  const rows = buildJobOrderUsageRows().map((row) => [
    row.jobNo || row.issuedFor,
    row.customer,
    row.jobParticulars,
    row.jobSize,
    row.timestamp,
    row.itemId,
    row.category,
    row.product,
    row.gauge,
    row.meters,
    row.remarks,
    row.rolls,
    row.totalWeight,
    row.user || ''
  ]);
  downloadText('jo-usage-report.csv', [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n'), 'text/csv');
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
  state.rollLabels = fresh.rollLabels;
  state.transactions = fresh.transactions.map((tx) => ({
    ...tx,
    localId: tx.localId || createLocalTransactionId()
  }));
  state.nextItemNumber = fresh.nextItemNumber;
  palletLabelEntries = null;
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

async function retryCloudConnection() {
  await initCloud();
  renderAll();
  toast(cloudEnabled ? 'Online database connected.' : 'Still offline. Check the error in Settings.');
}

function applyHashScan() {
  const match = location.hash.match(/^#(?:scan|incoming):(.+)$/);
  if (!match) return;
  showView('scan');
  selectScanValue(location.hash);
}

function legacyQrText(item) {
  return `${item.category}|${item.product}|${item.gauge}|${item.meters}|${item.remarks}|${Number(item.weightPerRoll || 0).toFixed(2)}`;
}

function activeItems() {
  return state.items.filter((item) => !isImportedTotalRow(item) && !isLegacyPalletRollItem(item));
}

function isLegacyPalletRollItem(item) {
  return /^Pallet\s+.+\/\s*Roll\s+\d+\s+of\s+\d+/i.test(String(item.remarks || '').trim());
}

function registerLegacyPalletQrAliases() {
  state.rollLabels = state.rollLabels || [];
  let changed = false;
  state.items.filter(isLegacyPalletRollItem).forEach((item) => {
    const existing = state.rollLabels.find((label) => label.qrId === item.id);
    const remark = String(item.remarks || '');
    const match = remark.match(/^Pallet\s+(.+?)\s*\/\s*Roll\s+(\d+)\s+of\s+(\d+)(?:\s*\/\s*(.*))?$/i);
    const master = findMasterForIncoming({
      category: item.category,
      product: item.product,
      gauge: item.gauge,
      meters: item.meters
    });
    const label = {
      qrId: item.id,
      itemId: master?.id || '',
      palletNo: match?.[1] || '',
      rollNumber: Number(match?.[2] || 1),
      totalRolls: Number(match?.[3] || 1),
      weightPerRoll: Number(item.weightPerRoll || 0),
      category: item.category,
      product: item.product,
      gauge: item.gauge,
      meters: item.meters,
      remarks: match?.[4] || '',
      delivered: state.transactions.some((tx) => tx.itemId === item.id)
    };
    if (existing) {
      Object.assign(existing, label);
    } else {
      state.rollLabels.push(label);
    }
    changed = true;
  });
  if (changed) saveState();
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
    beginning_rolls: item.beginningRolls ?? item.currentRolls,
    beginning_weight: item.beginningWeight ?? item.currentWeight,
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
    beginningRolls: Number(row.beginning_rolls ?? row.current_rolls ?? 0),
    beginningWeight: Number(row.beginning_weight ?? row.current_weight ?? 0),
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
    issued_for: tx.issuedFor || '',
    user_name: tx.user || ''
  };
}

function fromDbTransaction(row) {
  const item = state.items.find((candidate) => candidate.id === row.item_id) || {};
  return {
    localId: String(row.id ?? createLocalTransactionId()),
    dbId: row.id,
    timestamp: row.created_at,
    itemId: row.item_id,
    product: item.product || '',
    action: row.action,
    rolls: Number(row.rolls || 0),
    weightPerRoll: Number(row.weight_per_roll || 0),
    totalWeight: Number(row.total_weight || 0),
    balanceAfter: Number(row.balance_after || 0),
    issuedFor: row.issued_for || '',
    user: row.user_name || ''
  };
}

function nextItemNumberFromItems(items) {
  const nextItem = items.reduce((max, item) => {
    const match = String(item.id).match(/^QR-(\d+)$/);
    return match ? Math.max(max, Number(match[1]) + 1) : max;
  }, 1);
  return (state.rollLabels || []).reduce((max, label) => {
    const match = String(label.qrId).match(/^QR-(\d+)$/);
    return match ? Math.max(max, Number(match[1]) + 1) : max;
  }, nextItem);
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

function formatRollWeight(rolls, weight) {
  const rollText = formatBlankZero(rolls, 0);
  const weightText = formatBlankZero(weight, 2);
  return rollText || weightText ? `${rollText || '0'} / ${weightText || '0.00'}` : '';
}

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString();
}
