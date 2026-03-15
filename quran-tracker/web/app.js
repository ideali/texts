import init, { QuranTracker } from './pkg/quran_tracker_core.js';

let tracker = null;
let recognition = null;
let isListening = false;

// DOM Elements
const arabicText = document.getElementById('arabic-text');
const translationText = document.getElementById('translation-text');
const surahNameAr = document.getElementById('surah-name-ar');
const surahNameRu = document.getElementById('surah-name-ru');
const ayahIndicator = document.getElementById('ayah-indicator');
const matchScore = document.getElementById('match-score');
const statusText = document.getElementById('status-text');
const btnListen = document.getElementById('btn-listen');
const btnStop = document.getElementById('btn-stop');
const btnHistory = document.getElementById('btn-history');
const historyModal = document.getElementById('history-modal');
const historyList = document.getElementById('history-list');
const btnCloseHistory = document.getElementById('btn-close-history');

// Initialize
async function initialize() {
    try {
        statusText.textContent = 'Загрузка данных Корана...';

        // Init WASM
        await init();

        // Load Quran data
        const response = await fetch('./data/quran.json');
        const quranJson = await response.text();

        tracker = new QuranTracker(quranJson);
        statusText.textContent = `Загружено ${tracker.total_ayahs} аятов. Нажмите «Слушать».`;

        // Check Speech API support
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            statusText.textContent = 'Web Speech API не поддерживается. Используйте Chrome или Safari.';
            btnListen.disabled = true;
            return;
        }

        setupSpeechRecognition();
        setupEventListeners();
        loadHistory();

    } catch (err) {
        statusText.textContent = `Ошибка загрузки: ${err.message}`;
        console.error('Init error:', err);
    }
}

// Setup Web Speech API
function setupSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();

    recognition.lang = 'ar-SA';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;

    recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            const transcript = result[0].transcript.trim();

            if (!transcript) continue;

            // Try matching with WASM core
            try {
                const matchJson = tracker.find_ayah(transcript);
                const match = JSON.parse(matchJson);

                updateDisplay(match);

                if (result.isFinal) {
                    matchScore.textContent = `Совпадение: ${Math.round(match.score * 100)}%`;
                }
            } catch (e) {
                // No confident match yet — show what was heard
                if (result.isFinal) {
                    matchScore.textContent = `Распознано: "${transcript}" — совпадение не найдено`;
                }
            }
        }
    };

    recognition.onerror = (event) => {
        console.error('Speech error:', event.error);
        if (event.error === 'no-speech') {
            statusText.textContent = 'Речь не обнаружена. Говорите ближе к микрофону.';
        } else if (event.error === 'not-allowed') {
            statusText.textContent = 'Доступ к микрофону запрещён. Разрешите доступ в настройках.';
            stopListening();
        } else {
            statusText.textContent = `Ошибка распознавания: ${event.error}`;
        }
    };

    recognition.onend = () => {
        // Auto-restart if still in listening mode
        if (isListening) {
            try {
                recognition.start();
            } catch (e) {
                console.log('Restart failed, retrying...', e);
                setTimeout(() => {
                    if (isListening) {
                        try { recognition.start(); } catch (e2) { stopListening(); }
                    }
                }, 500);
            }
        }
    };
}

// Update the display with a matched ayah
function updateDisplay(match) {
    // Animate transition
    arabicText.style.opacity = '0';
    translationText.style.opacity = '0';

    setTimeout(() => {
        arabicText.textContent = match.arabic;
        arabicText.classList.add('active');
        translationText.textContent = match.translation;

        surahNameAr.textContent = match.surah_name_ar;
        surahNameRu.textContent = match.surah_name_ru;
        ayahIndicator.textContent = `${match.surah}:${match.ayah}`;

        arabicText.style.opacity = '1';
        translationText.style.opacity = '1';
    }, 200);

    // Remove active glow after a moment
    setTimeout(() => {
        arabicText.classList.remove('active');
    }, 3000);
}

// Start listening
function startListening() {
    if (!recognition) return;

    try {
        recognition.start();
        isListening = true;

        btnListen.style.display = 'none';
        btnStop.style.display = 'flex';
        btnListen.classList.add('listening');
        statusText.textContent = 'Слушаю чтение Корана...';
    } catch (e) {
        statusText.textContent = `Не удалось начать: ${e.message}`;
    }
}

// Stop listening
function stopListening() {
    isListening = false;

    if (recognition) {
        try { recognition.stop(); } catch (e) {}
    }

    btnStop.style.display = 'none';
    btnListen.style.display = 'flex';
    btnListen.classList.remove('listening');
    statusText.textContent = 'Остановлено.';

    // Save session to history
    saveSession();
}

// Save session
function saveSession() {
    try {
        const now = new Date().toISOString().split('T')[0];
        const sessionJson = tracker.end_session(now);
        const session = JSON.parse(sessionJson);

        const history = getHistory();
        history.unshift(session);
        localStorage.setItem('quran-tracker-history', JSON.stringify(history));
    } catch (e) {
        // No active session — nothing to save
    }
}

// Load history from localStorage
function getHistory() {
    try {
        return JSON.parse(localStorage.getItem('quran-tracker-history') || '[]');
    } catch {
        return [];
    }
}

function loadHistory() {
    renderHistory();
}

function renderHistory() {
    const history = getHistory();

    if (history.length === 0) {
        historyList.innerHTML = '<p class="empty-state">Пока нет записей</p>';
        return;
    }

    historyList.innerHTML = history.map(entry => `
        <div class="history-item">
            <div class="date">${entry.date}</div>
            <div class="surah-info">
                Сура ${entry.surah}, аяты ${entry.ayah_from}–${entry.ayah_to}
            </div>
        </div>
    `).join('');
}

// Event listeners
function setupEventListeners() {
    btnListen.addEventListener('click', startListening);
    btnStop.addEventListener('click', stopListening);

    btnHistory.addEventListener('click', () => {
        renderHistory();
        historyModal.style.display = 'flex';
    });

    btnCloseHistory.addEventListener('click', () => {
        historyModal.style.display = 'none';
    });

    historyModal.addEventListener('click', (e) => {
        if (e.target === historyModal) {
            historyModal.style.display = 'none';
        }
    });
}

// Start the app
initialize();
