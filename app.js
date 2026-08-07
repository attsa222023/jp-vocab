// ---- 跨裝置同步（Firestore）----
import { db } from './firebase-init.js';
import {
  doc,
  setDoc,
  getDoc,
  onSnapshot,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';

function syncDocRef(code) {
  return doc(db, 'vocabSyncs', code);
}

// ---- 資料儲存 ----
const STORAGE_KEY = 'jpVocabWords';
const SYNC_CODE_KEY = 'jpVocabSyncCode';

// 這幾個同步用的狀態變數要放在 loadWords()/saveWords() 之前宣告，
// 因為 loadWords() 內可能會呼叫到 saveWords() -> queueCloudPush()，
// 若 syncCode 還沒宣告（let 的暫時死區）會直接噴錯。
let syncCode = localStorage.getItem(SYNC_CODE_KEY) || null;
let syncUnsubscribe = null;
let syncStatusText = syncCode ? '連線中...' : '尚未連結';
let pushTimer = null;

function loadWords() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    // 舊資料沒有 addedAt（精確新增時間戳記），用陣列順序（原本的新增順序）補上，
    // 這樣「由新到舊 / 由舊到新」排序在舊資料上也能維持正確的先後關係
    let migrated = false;
    list.forEach((w, i) => {
      if (typeof w.addedAt !== 'number') {
        w.addedAt = i;
        migrated = true;
      }
    });
    if (migrated) saveWords(list);
    return list;
  } catch (e) {
    console.error('讀取資料失敗', e);
    return [];
  }
}

function saveWords(words) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(words));
  queueCloudPush();
}

let words = loadWords();

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 全部用「本地時間」計算日期字串，避免 toISOString() 轉成 UTC 導致跨時區日期偏移
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayStr() {
  return formatDate(new Date());
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return formatDate(dt);
}

// ---- 新增單字 ----
function createWord({ word, reading, meaning, note }) {
  const today = todayStr();
  return {
    id: uid(),
    word,
    reading: reading || '',
    meaning,
    note: note || '',
    createdAt: today,
    addedAt: Date.now(),
    srs: {
      interval: 0,      // 天數
      repetition: 0,    // 連續答對次數
      easeFactor: 2.5,
      dueDate: today,   // 今天就可以複習
    },
  };
}

const addForm = document.getElementById('addForm');
const addFeedback = document.getElementById('addFeedback');

addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const word = document.getElementById('word').value.trim();
  const reading = document.getElementById('reading').value.trim();
  const meaning = document.getElementById('meaning').value.trim();
  const note = document.getElementById('note').value.trim();

  if (!word || !meaning) return;

  words.push(createWord({ word, reading, meaning, note }));
  saveWords(words);

  addForm.reset();
  document.getElementById('word').focus();

  addFeedback.textContent = `已儲存「${word}」！目前共有 ${words.length} 個單字。`;
  addFeedback.hidden = false;
  clearTimeout(addFeedback._t);
  addFeedback._t = setTimeout(() => { addFeedback.hidden = true; }, 2500);

  refreshDueBadge();
  renderList();
});

// ---- SM-2 簡化版間隔重複演算法 ----
// grade: 0=Again 1=Hard 2=Good 3=Easy
function scheduleNext(srs, grade) {
  let { interval, repetition, easeFactor } = srs;

  if (grade === 0) {
    // 答錯：打回原形，明天再複習
    repetition = 0;
    interval = 1;
    easeFactor = Math.max(1.3, easeFactor - 0.2);
  } else {
    if (repetition === 0) {
      interval = 1;
    } else if (repetition === 1) {
      interval = grade === 3 ? 4 : 3;
    } else {
      const factorAdj = grade === 1 ? 1.2 : grade === 3 ? easeFactor + 0.15 : easeFactor;
      interval = Math.round(interval * factorAdj);
    }
    repetition += 1;

    if (grade === 1) easeFactor = Math.max(1.3, easeFactor - 0.15);
    if (grade === 3) easeFactor = easeFactor + 0.1;
  }

  return {
    interval,
    repetition,
    easeFactor: Math.round(easeFactor * 100) / 100,
    dueDate: addDays(todayStr(), interval),
  };
}

// ---- Tab 切換 ----
const tabBtns = document.querySelectorAll('.tab-btn');
const views = document.querySelectorAll('.view');

tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabBtns.forEach((b) => b.classList.remove('active'));
    views.forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`view-${btn.dataset.view}`).classList.add('active');

    if (btn.dataset.view === 'review') renderReview();
    if (btn.dataset.view === 'list') renderList();
    if (btn.dataset.view === 'sync') renderSync();
  });
});

// ---- 複習畫面 ----
const reviewArea = document.getElementById('reviewArea');
let reviewQueue = [];
let currentCard = null;
let revealed = false;

function getDueWords() {
  const today = todayStr();
  return words.filter((w) => w.srs.dueDate <= today);
}

function refreshDueBadge() {
  const badge = document.getElementById('dueBadge');
  const count = getDueWords().length;
  if (count > 0) {
    badge.textContent = count;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function renderReview() {
  reviewQueue = getDueWords();
  revealed = false;
  nextCard();
}

function nextCard() {
  revealed = false;
  if (reviewQueue.length === 0) {
    currentCard = null;
    reviewArea.innerHTML = `
      <div class="empty-state">
        <div class="big">🎉</div>
        <p>${words.length === 0 ? '還沒有任何單字，先去新增幾個吧！' : '目前沒有到期的單字，已經複習完了！'}</p>
      </div>`;
    refreshDueBadge();
    return;
  }
  currentCard = reviewQueue[0];
  renderCard();
}

function renderCard() {
  const w = currentCard;
  reviewArea.innerHTML = `
    <div class="review-card" id="flipCard">
      <div class="review-word">${escapeHtml(w.word)}</div>
      ${revealed ? `
        ${w.reading ? `<div class="review-reading">${escapeHtml(w.reading)}</div>` : ''}
        <div class="review-meaning">${escapeHtml(w.meaning)}</div>
        ${w.note ? `<div class="review-note">${escapeHtml(w.note)}</div>` : ''}
      ` : `<div class="hint">點一下卡片顯示答案</div>`}
    </div>
    ${revealed ? `
      <div class="grade-btns">
        <button class="grade-btn grade-again" data-grade="0">忘記了</button>
        <button class="grade-btn grade-hard" data-grade="1">有點難</button>
        <button class="grade-btn grade-good" data-grade="2">記得</button>
        <button class="grade-btn grade-easy" data-grade="3">很簡單</button>
      </div>
    ` : ''}
    <p class="hint" style="text-align:center;">剩餘待複習：${reviewQueue.length}</p>
  `;

  document.getElementById('flipCard').addEventListener('click', () => {
    revealed = true;
    renderCard();
  });

  if (revealed) {
    document.querySelectorAll('.grade-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const grade = Number(btn.dataset.grade);
        currentCard.srs = scheduleNext(currentCard.srs, grade);
        saveWords(words);
        reviewQueue.shift();
        nextCard();
      });
    });
  }
}

// ---- 單字庫畫面 ----
const wordListEl = document.getElementById('wordList');
const searchInput = document.getElementById('searchInput');
const wordCountEl = document.getElementById('wordCount');
const sortSelect = document.getElementById('sortSelect');

let editingId = null;

const SORT_MODE_KEY = 'jpVocabSortMode';
let sortMode = localStorage.getItem(SORT_MODE_KEY) || 'new';
sortSelect.value = sortMode;

// 假名排序用的排序器：兼顧平假名/片假名、濁音等日文排序規則
const kanaCollator = new Intl.Collator('ja', { sensitivity: 'base' });

function sortWords(list) {
  const arr = [...list];
  if (sortMode === 'old') {
    arr.sort((a, b) => a.addedAt - b.addedAt);
  } else if (sortMode === 'kana') {
    arr.sort((a, b) => kanaCollator.compare(a.reading || a.word, b.reading || b.word));
  } else {
    // 預設：由新到舊
    arr.sort((a, b) => b.addedAt - a.addedAt);
  }
  return arr;
}

searchInput.addEventListener('input', renderList);

sortSelect.addEventListener('change', () => {
  sortMode = sortSelect.value;
  localStorage.setItem(SORT_MODE_KEY, sortMode);
  renderList();
});

function renderList() {
  const q = searchInput.value.trim().toLowerCase();
  const filtered = sortWords(
    words.filter((w) =>
      !q ||
      w.word.toLowerCase().includes(q) ||
      w.reading.toLowerCase().includes(q) ||
      w.meaning.toLowerCase().includes(q)
    )
  );

  wordCountEl.textContent = `共 ${words.length} 個單字`;

  if (filtered.length === 0) {
    wordListEl.innerHTML = `<div class="empty-state"><div class="big">📭</div><p>找不到符合的單字</p></div>`;
    return;
  }

  const today = todayStr();
  wordListEl.innerHTML = filtered.map((w) => {
    if (w.id === editingId) return renderEditForm(w);

    const isDue = w.srs.dueDate <= today;
    return `
      <li class="word-item" data-id="${w.id}">
        <div class="word-item-top">
          <span class="word-item-word">${escapeHtml(w.word)}</span>
          <span class="word-item-reading">${escapeHtml(w.reading)}</span>
        </div>
        <div class="word-item-meaning">${escapeHtml(w.meaning)}</div>
        ${w.note ? `<div class="word-item-note">${escapeHtml(w.note)}</div>` : ''}
        <div class="word-item-meta">
          <span class="due-tag ${isDue ? 'due-now' : ''}">${isDue ? '待複習' : '下次複習：' + w.srs.dueDate}</span>
          <span class="word-item-actions">
            <button data-action="edit">編輯</button>
            <button data-action="delete">刪除</button>
          </span>
        </div>
      </li>
    `;
  }).join('');

  wordListEl.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const li = e.target.closest('.word-item');
      const id = li.dataset.id;
      const target = words.find((w) => w.id === id);
      if (target && confirm(`確定要刪除「${target.word}」嗎？`)) {
        words = words.filter((w) => w.id !== id);
        saveWords(words);
        if (editingId === id) editingId = null;
        renderList();
        refreshDueBadge();
      }
    });
  });

  wordListEl.querySelectorAll('[data-action="edit"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const li = e.target.closest('.word-item');
      editingId = li.dataset.id;
      renderList();
    });
  });

  if (editingId) attachEditFormHandlers();
}

function renderEditForm(w) {
  return `
    <li class="word-item word-item-editing" data-id="${w.id}">
      <form class="edit-form" data-id="${w.id}">
        <div class="field">
          <label>單字 / 漢字</label>
          <input name="word" type="text" value="${escapeHtml(w.word)}" required autocomplete="off">
        </div>
        <div class="field">
          <label>讀音（假名）</label>
          <input name="reading" type="text" value="${escapeHtml(w.reading)}" autocomplete="off">
        </div>
        <div class="field">
          <label>意思</label>
          <input name="meaning" type="text" value="${escapeHtml(w.meaning)}" required autocomplete="off">
        </div>
        <div class="field">
          <label>備註 / 例句（選填）</label>
          <textarea name="note" rows="2">${escapeHtml(w.note)}</textarea>
        </div>
        <div class="edit-form-actions">
          <button type="submit" class="primary-btn">儲存修改</button>
          <button type="button" data-action="cancel-edit">取消</button>
        </div>
      </form>
    </li>
  `;
}

function attachEditFormHandlers() {
  const form = wordListEl.querySelector('.edit-form');
  if (!form) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = form.dataset.id;
    const target = words.find((w) => w.id === id);
    if (!target) return;

    const word = form.elements['word'].value.trim();
    const reading = form.elements['reading'].value.trim();
    const meaning = form.elements['meaning'].value.trim();
    const note = form.elements['note'].value.trim();
    if (!word || !meaning) return;

    target.word = word;
    target.reading = reading;
    target.meaning = meaning;
    target.note = note;
    saveWords(words);

    editingId = null;
    renderList();
  });

  form.querySelector('[data-action="cancel-edit"]').addEventListener('click', () => {
    editingId = null;
    renderList();
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---- 跨裝置同步畫面 ----
const syncArea = document.getElementById('syncArea');

function generateSyncCode() {
  // 排除容易看錯的字元（0/O、1/I/L）
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

// 合併本機與雲端的單字清單：以 id 為準，重複時保留本機版本
// （本機通常是剛做完編輯、最新的那份）
function mergeWordsById(localList, cloudList) {
  const map = new Map();
  cloudList.forEach((w) => map.set(w.id, w));
  localList.forEach((w) => map.set(w.id, w));
  return [...map.values()];
}

function setSyncStatus(text) {
  syncStatusText = text;
  if (document.getElementById('view-sync').classList.contains('active')) renderSync();
}

function queueCloudPush() {
  if (!syncCode) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    setDoc(syncDocRef(syncCode), { words, updatedAt: serverTimestamp() })
      .then(() => setSyncStatus(`已同步（${new Date().toLocaleTimeString('zh-TW')} 更新）`))
      .catch((err) => {
        console.error('推送同步失敗', err);
        setSyncStatus('同步失敗，請檢查網路連線');
      });
  }, 400);
}

function applyRemoteWords(remoteWords) {
  words = remoteWords;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(words));
  refreshDueBadge();
  const activeView = document.querySelector('.view.active')?.id;
  if (activeView === 'view-list') renderList();
  if (activeView === 'view-review') renderReview();
}

function attachSyncListener() {
  if (syncUnsubscribe) syncUnsubscribe();
  const listeningToCode = syncCode;
  syncUnsubscribe = onSnapshot(
    syncDocRef(listeningToCode),
    (snap) => {
      if (syncCode !== listeningToCode) return; // 這個監聽器已經過期（換了/取消了同步碼），忽略
      if (!snap.exists() || snap.metadata.hasPendingWrites) return; // 自己剛寫入的，不用處理
      const data = snap.data();
      if (!data || !Array.isArray(data.words)) return;
      applyRemoteWords(data.words);
      setSyncStatus(`已同步（${new Date().toLocaleTimeString('zh-TW')} 更新）`);
    },
    (err) => {
      console.error('同步監聽失敗', err);
      setSyncStatus('同步連線中斷，請檢查網路');
    }
  );
}

async function startNewSync() {
  const code = generateSyncCode();
  setSyncStatus('建立中...');
  try {
    await setDoc(syncDocRef(code), { words, updatedAt: serverTimestamp() });
    syncCode = code;
    localStorage.setItem(SYNC_CODE_KEY, code);
    attachSyncListener();
    setSyncStatus('已連結，正在即時同步');
  } catch (err) {
    console.error('建立同步失敗', err);
    setSyncStatus('建立失敗，請檢查網路連線');
  }
  renderSync();
}

async function joinSync(rawCode) {
  const code = rawCode.trim().toUpperCase();
  if (!code) return;
  setSyncStatus('連結中...');
  renderSync();
  try {
    const snap = await getDoc(syncDocRef(code));
    if (!snap.exists()) {
      setSyncStatus('找不到這組同步碼，請確認輸入是否正確');
      renderSync();
      return;
    }
    const cloudWords = Array.isArray(snap.data().words) ? snap.data().words : [];
    words = mergeWordsById(words, cloudWords);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(words));
    await setDoc(syncDocRef(code), { words, updatedAt: serverTimestamp() });

    syncCode = code;
    localStorage.setItem(SYNC_CODE_KEY, code);
    attachSyncListener();
    setSyncStatus('已連結，正在即時同步');
    refreshDueBadge();
    renderList();
  } catch (err) {
    console.error('連結同步失敗', err);
    setSyncStatus('連結失敗，請檢查網路連線與同步碼是否正確');
  }
  renderSync();
}

function disconnectSync() {
  if (syncUnsubscribe) {
    syncUnsubscribe();
    syncUnsubscribe = null;
  }
  syncCode = null;
  localStorage.removeItem(SYNC_CODE_KEY);
  setSyncStatus('尚未連結');
  renderSync();
}

function renderSync() {
  if (syncCode) {
    syncArea.innerHTML = `
      <p class="sync-status">${escapeHtml(syncStatusText)}</p>
      <div class="field">
        <label>這台裝置的同步碼</label>
        <div class="sync-code-display">
          <span class="sync-code">${escapeHtml(syncCode)}</span>
          <button type="button" id="copyCodeBtn">複製</button>
        </div>
      </div>
      <p class="hint">在另一台裝置的「☁️ 同步」分頁輸入這組碼，就能看到同一份單字，並即時保持同步。</p>
      <button type="button" id="disconnectBtn" class="secondary-btn">中斷同步（雲端資料不會刪除）</button>
    `;
    document.getElementById('copyCodeBtn').addEventListener('click', () => {
      const btn = document.getElementById('copyCodeBtn');
      navigator.clipboard?.writeText(syncCode).then(() => {
        btn.textContent = '已複製！';
        setTimeout(() => { btn.textContent = '複製'; }, 1500);
      });
    });
    document.getElementById('disconnectBtn').addEventListener('click', () => {
      if (confirm('確定要中斷這台裝置的同步嗎？（雲端上的資料仍會保留，之後可以用同一組碼重新連結）')) {
        disconnectSync();
      }
    });
  } else {
    syncArea.innerHTML = `
      <p>把這台裝置的單字同步到雲端，就能在其他裝置（電腦、手機）上看到同一份資料，並即時保持更新。</p>
      <button type="button" id="startSyncBtn" class="primary-btn">產生同步碼，開始同步</button>
      <hr class="divider">
      <div class="field">
        <label for="joinCodeInput">已經有同步碼了？輸入來連結這台裝置</label>
        <input id="joinCodeInput" type="text" placeholder="例：7F3K9QXZ" maxlength="8" autocomplete="off" style="text-transform:uppercase;">
      </div>
      <button type="button" id="joinSyncBtn">連結</button>
      <p class="sync-status">${escapeHtml(syncStatusText)}</p>
    `;
    document.getElementById('startSyncBtn').addEventListener('click', startNewSync);
    document.getElementById('joinSyncBtn').addEventListener('click', () => {
      joinSync(document.getElementById('joinCodeInput').value);
    });
  }
}

// ---- 手動備份（匯出／匯入 JSON）----
const backupFeedback = document.getElementById('backupFeedback');

function showBackupFeedback(text, isError) {
  backupFeedback.textContent = text;
  backupFeedback.style.color = isError ? 'var(--danger)' : '';
  backupFeedback.hidden = false;
}

function exportWordsToFile() {
  const blob = new Blob([JSON.stringify(words, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `jp-vocab-backup-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showBackupFeedback(`已匯出 ${words.length} 個單字。`);
}

// 把匯入的資料補齊成完整的單字物件，缺欄位就用預設值，避免舊格式或手動編輯過的檔案匯入時壞掉
function normalizeImportedWord(raw) {
  const today = todayStr();
  const word = typeof raw?.word === 'string' ? raw.word.trim() : '';
  const meaning = typeof raw?.meaning === 'string' ? raw.meaning.trim() : '';
  if (!word || !meaning) return null;

  const srsRaw = raw.srs && typeof raw.srs === 'object' ? raw.srs : {};
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
    word,
    reading: typeof raw.reading === 'string' ? raw.reading.trim() : '',
    meaning,
    note: typeof raw.note === 'string' ? raw.note.trim() : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : today,
    addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : Date.now(),
    srs: {
      interval: Number.isFinite(srsRaw.interval) ? srsRaw.interval : 0,
      repetition: Number.isFinite(srsRaw.repetition) ? srsRaw.repetition : 0,
      easeFactor: Number.isFinite(srsRaw.easeFactor) ? srsRaw.easeFactor : 2.5,
      dueDate: typeof srsRaw.dueDate === 'string' ? srsRaw.dueDate : today,
    },
  };
}

function importWordsFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch {
      showBackupFeedback('匯入失敗：這不是有效的 JSON 檔案。', true);
      return;
    }
    if (!Array.isArray(parsed)) {
      showBackupFeedback('匯入失敗：檔案內容格式不對（應該是單字清單）。', true);
      return;
    }
    const normalized = parsed.map(normalizeImportedWord).filter(Boolean);
    if (normalized.length === 0) {
      showBackupFeedback('匯入失敗：檔案裡沒有找到有效的單字資料。', true);
      return;
    }
    const beforeCount = words.length;
    words = mergeWordsById(words, normalized);
    saveWords(words);
    refreshDueBadge();
    renderList();
    showBackupFeedback(`匯入完成，新增了 ${words.length - beforeCount} 個單字（目前共 ${words.length} 個）。`);
  };
  reader.onerror = () => showBackupFeedback('匯入失敗：讀取檔案時發生錯誤。', true);
  reader.readAsText(file, 'utf-8');
}

document.getElementById('exportBtn').addEventListener('click', exportWordsToFile);
document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFileInput').click();
});
document.getElementById('importFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) importWordsFromFile(file);
  e.target.value = ''; // 允許重複選同一個檔案再匯入一次
});

// ---- PWA：註冊 service worker，讓應用程式可以安裝到主畫面、離線也能開 ----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.error('Service worker 註冊失敗', err);
    });
  });
}

// ---- 初始化 ----
refreshDueBadge();
renderList();
if (syncCode) attachSyncListener();
