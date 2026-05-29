const STORE_KEY = 'qrInventoryApp:v1';
const SUPABASE = window.SUPABASE_CONFIG || null;

const state = loadState();
const el = (id) => document.getElementById(id);

const viewMeta = {
  dashboard: ['Dashboard', 'Live stock summary and recent movement'],
  scan: ['Scan', 'Post IN and OUT transactions from QR codes'],
  inventory: ['Inventory', 'Manage rolls, weights, and stock status'],
  transactions: ['Transactions', 'Audit trail of all movement'],
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
    items: (window.STARTER_ITEMS || []).map((item) => ({ ...item })),
    transactions: [],
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
  el('printBtn').addEventListener('click', () => window.print());
  el('exportBtn').addEventListener('click', exportTransactionsCsv);
  el('backupBtn').addEventListener('click', downloadBackup);
  el('downloadBackupBtn').addEventListener('click', downloadBackup);
  el('restoreInput').addEventListener('change', restoreBackup);
  el('resetBtn').addEventListener('click', resetLocalData);
  el('addItemBtn').addEventListener('click', () => el('itemDialog').showModal());
  el('cancelItemBtn').addEventListener('click', () => el('itemDialog').close());
  el('itemForm').addEventListener('submit', saveNewItem);
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
  renderLabels();
}

function renderCategories() {
  const select = el('categoryFilter');
  const current = select.value;
  const categories = [...new Set(state.items.map((item) => item.category).filter(Boolean))].sort();
  select.innerHTML = '<option value="">All categories</option>' + categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
  select.value = current;
}

function renderDashboard() {
  const totalRolls = state.items.reduce((sum, item) => sum + Number(item.currentRolls || 0), 0);
  const totalWeight = state.items.reduce((sum, item) => sum + Number(item.currentWeight || 0), 0);
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = state.transactions.filter((tx) => tx.timestamp.slice(0, 10) === today).length;

  el('mRolls').textContent = formatNumber(totalRolls, 0);
  el('mWeight').textContent = formatNumber(totalWeight, 2);
  el('mItems').textContent = state.items.length;
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
  const rows = state.items.filter((item) => {
    const text = `${item.id} ${item.category} ${item.product} ${item.gauge} ${item.meters} ${item.remarks}`.toLowerCase();
    return (!query || text.includes(query)) && (!category || item.category === category);
  });

  el('inventoryRows').innerHTML = rows.map((item) => {
    const status = Number(item.currentRolls || 0) <= 0 ? 'low' : Number(item.currentRolls || 0) <= Number(item.minRolls || 0) ? 'warn' : 'ok';
    const label = status === 'ok' ? 'OK' : status === 'warn' ? 'LOW' : 'ZERO';
    return `<tr>
      <td>${escapeHtml(item.id)}</td>
      <td>${escapeHtml(item.category)}</td>
      <td>${escapeHtml(item.product)}</td>
      <td>${escapeHtml(item.gauge)}</td>
      <td>${escapeHtml(item.meters)}</td>
      <td>${escapeHtml(item.remarks)}</td>
      <td>${formatNumber(item.currentRolls, 0)}</td>
      <td>${formatNumber(item.currentWeight, 2)}</td>
      <td><span class="pill ${status}">${label}</span></td>
    </tr>`;
  }).join('') || `<tr><td colspan="9">No matching items.</td></tr>`;
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

function renderLabels() {
  const query = el('labelSearch').value.trim().toLowerCase();
  const items = state.items.filter((item) => {
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

  return state.items.find((item) => item.id.toLowerCase() === normalized.toLowerCase())
    || state.items.find((item) => legacyQrText(item).toLowerCase() === normalized.toLowerCase());
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
      <label>User<input id="actionUser" placeholder="Name or initials"></label>
      <button class="primary" id="postInBtn">Post IN</button>
      <button class="danger" id="postOutBtn">Post OUT</button>
    </div>
  `;

  document.getElementById('postInBtn').addEventListener('click', () => postTransaction('IN'));
  document.getElementById('postOutBtn').addEventListener('click', () => postTransaction('OUT'));
}

function postTransaction(action) {
  if (!selectedItem) return;
  const rolls = Number(document.getElementById('actionRolls').value);
  const user = document.getElementById('actionUser').value.trim();

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

  saveState();
  syncTransactionToCloud(selectedItem, state.transactions[state.transactions.length - 1]);
  renderAll();
  renderScanResult();
  toast(`${action} posted for ${selectedItem.id}.`);
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

async function syncNewItemToCloud(item) {
  if (!cloudEnabled) return;
  try {
    await cloudInsert('items', [toDbItem(item)]);
  } catch (error) {
    setSyncStatus('Sync error', 'offline');
    toast(`Item saved locally, but cloud sync failed: ${error.message}`);
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

function applyHashScan() {
  const match = location.hash.match(/^#scan:(.+)$/);
  if (!match) return;
  showView('scan');
  selectScanValue(decodeURIComponent(match[1]));
}

function legacyQrText(item) {
  return `${item.category}|${item.product}|${item.gauge}|${item.meters}|${item.remarks}|${Number(item.weightPerRoll || 0).toFixed(2)}`;
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

function fromDbItem(row) {
  return {
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
  };
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

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString();
}
