// Standalone version — no WASM dependency, pure JS matching
// For mobile testing via GitHub Pages

let quranData = [];
let currentSurah = 0;
let currentAyah = 0;
let sessionStartSurah = 0;
let sessionStartAyah = 0;
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

// ===================== Arabic Text Processing =====================

function isArabicDiacritic(charCode) {
    return (charCode >= 0x0610 && charCode <= 0x061A) ||
           (charCode >= 0x064B && charCode <= 0x065F) ||
           charCode === 0x0670 ||
           (charCode >= 0x06D6 && charCode <= 0x06DC) ||
           (charCode >= 0x06DF && charCode <= 0x06E4) ||
           (charCode >= 0x06E7 && charCode <= 0x06E8) ||
           (charCode >= 0x06EA && charCode <= 0x06ED);
}

function cleanArabic(text) {
    let result = '';
    for (const ch of text) {
        if (!isArabicDiacritic(ch.codePointAt(0))) {
            result += ch;
        }
    }
    return result.split(/\s+/).filter(Boolean).join(' ');
}

// Bigram-based Dice similarity (matches the Rust implementation)
function bigrams(s) {
    const chars = [...s];
    const result = [];
    for (let i = 0; i < chars.length - 1; i++) {
        result.push(chars[i] + chars[i + 1]);
    }
    return result;
}

function similarity(a, b) {
    if (!a || !b) return 0;
    const ba = bigrams(a);
    const bb = bigrams(b);
    if (ba.length === 0 && bb.length === 0) {
        return a === b ? 1.0 : 0.0;
    }
    const used = new Array(bb.length).fill(false);
    let matches = 0;
    for (const bg of ba) {
        for (let j = 0; j < bb.length; j++) {
            if (!used[j] && bg === bb[j]) {
                matches++;
                used[j] = true;
                break;
            }
        }
    }
    return (2 * matches) / (ba.length + bb.length);
}

// ===================== Matching Engine =====================

// Pre-computed cleaned versions
let cleanedAyahs = [];

function findAyah(recognizedText) {
    const cleaned = cleanArabic(recognizedText);
    if (!cleaned) return null;

    let bestIdx = 0;
    let bestScore = 0;

    for (let i = 0; i < quranData.length; i++) {
        let score = similarity(cleaned, cleanedAyahs[i]);

        // Position boost for sequential reading
        if (currentSurah > 0) {
            const a = quranData[i];
            if (a.surah === currentSurah && a.ayah === currentAyah + 1) {
                score += 0.15;
            } else if (a.surah === currentSurah && a.ayah === currentAyah) {
                score += 0.05;
            }
        }

        if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
        }
    }

    if (bestScore < 0.25) return null;

    const matched = quranData[bestIdx];

    if (currentSurah === 0) {
        sessionStartSurah = matched.surah;
        sessionStartAyah = matched.ayah;
    }
    currentSurah = matched.surah;
    currentAyah = matched.ayah;

    return {
        ...matched,
        score: bestScore
    };
}

// ===================== Initialize =====================

async function initialize() {
    try {
        statusText.textContent = 'Загрузка данных Корана...';

        // Try full data first, fall back to smaller dataset
        let response = await fetch('./data/quran_full.json').catch(() => null);
        if (!response || !response.ok) {
            response = await fetch('./data/quran.json');
        }
        quranData = await response.json();

        // Pre-compute cleaned versions
        cleanedAyahs = quranData.map(a => cleanArabic(a.arabic));

        statusText.textContent = `Загружено ${quranData.length} аятов. Нажмите «Слушать».`;

        // Check Speech API support
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            statusText.textContent = 'Web Speech API не поддерживается в этом браузере. Используйте Chrome или Safari.';
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

// ===================== Speech Recognition =====================

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

            const match = findAyah(transcript);

            if (match) {
                updateDisplay(match);
                if (result.isFinal) {
                    matchScore.textContent = `Совпадение: ${Math.round(match.score * 100)}%`;
                }
            } else if (result.isFinal) {
                matchScore.textContent = `Распознано: "${transcript}" — совпадение не найдено`;
            }
        }
    };

    recognition.onerror = (event) => {
        console.error('Speech error:', event.error);
        if (event.error === 'no-speech') {
            statusText.textContent = 'Речь не обнаружена. Говорите ближе к микрофону.';
        } else if (event.error === 'not-allowed') {
            statusText.textContent = 'Доступ к микрофону запрещён. Разрешите в настройках браузера.';
            stopListening();
        } else {
            statusText.textContent = `Ошибка распознавания: ${event.error}`;
        }
    };

    recognition.onend = () => {
        if (isListening) {
            try {
                recognition.start();
            } catch (e) {
                setTimeout(() => {
                    if (isListening) {
                        try { recognition.start(); } catch (e2) { stopListening(); }
                    }
                }, 500);
            }
        }
    };
}

// ===================== UI =====================

function updateDisplay(match) {
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

    setTimeout(() => {
        arabicText.classList.remove('active');
    }, 3000);
}

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

function stopListening() {
    isListening = false;

    if (recognition) {
        try { recognition.stop(); } catch (e) {}
    }

    btnStop.style.display = 'none';
    btnListen.style.display = 'flex';
    btnListen.classList.remove('listening');
    statusText.textContent = 'Остановлено.';

    saveSession();
}

// ===================== History =====================

function saveSession() {
    if (currentSurah === 0) return;

    const entry = {
        surah: sessionStartSurah,
        ayah_from: sessionStartAyah,
        ayah_to: currentAyah,
        date: new Date().toISOString().split('T')[0],
        surah_name: quranData.find(a => a.surah === sessionStartSurah)?.surah_name_ru || ''
    };

    const history = getHistory();
    history.unshift(entry);
    localStorage.setItem('quran-tracker-history', JSON.stringify(history));

    // Reset session
    currentSurah = 0;
    currentAyah = 0;
    sessionStartSurah = 0;
    sessionStartAyah = 0;
}

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
                ${entry.surah_name || 'Сура ' + entry.surah}, аяты ${entry.ayah_from}–${entry.ayah_to}
            </div>
        </div>
    `).join('');
}

// ===================== Event Listeners =====================

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

// Start
initialize();
