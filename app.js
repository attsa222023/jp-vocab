// ---- 資料儲存 ----
const STORAGE_KEY = 'jpVocabWords';

function loadWords() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('讀取資料失敗', e);
    return [];
  }
}

function saveWords(words) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(words));
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

searchInput.addEventListener('input', renderList);

function renderList() {
  const q = searchInput.value.trim().toLowerCase();
  const filtered = words
    .filter((w) =>
      !q ||
      w.word.toLowerCase().includes(q) ||
      w.reading.toLowerCase().includes(q) ||
      w.meaning.toLowerCase().includes(q)
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  wordCountEl.textContent = `共 ${words.length} 個單字`;

  if (filtered.length === 0) {
    wordListEl.innerHTML = `<div class="empty-state"><div class="big">📭</div><p>找不到符合的單字</p></div>`;
    return;
  }

  const today = todayStr();
  wordListEl.innerHTML = filtered.map((w) => {
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
          <span class="word-item-actions"><button data-action="delete">刪除</button></span>
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
        renderList();
        refreshDueBadge();
      }
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---- 初始化 ----
refreshDueBadge();
renderList();
