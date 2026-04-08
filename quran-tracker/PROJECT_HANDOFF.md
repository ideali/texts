# Quran Recitation Tracker — Полный контекст проекта

## Идея продукта

Приложение для использования во время намаза (кыям). Пользователь держит телефон в руках, имам читает Коран вслух. Приложение:
1. Слушает чтение через микрофон
2. Распознаёт какую суру и аят читает имам
3. Показывает арабский текст аята с подсветкой
4. Показывает русский тафсир/перевод ниже
5. Автоматически следит за чтением аят за аятом

**Условия использования**: мечеть или комната, тишина кроме чтения имама, возможно нет интернета.

---

## Принятые решения

| Вопрос | Решение | Почему |
|--------|---------|--------|
| Платформа | Web (mobile-first), потом iOS | Быстрый прототип |
| Ядро | Rust → WebAssembly | Быстрый fuzzy matching по 6236 аятам |
| Распознавание речи | Web Speech API (MVP) | Бесплатно, без API-ключей |
| Будущее распознавание | offline-tarteel (ONNX модель в браузере) | 87% точность, работает офлайн |
| Тафсир/перевод | Ас-Саади (русский) | Ибн Касир на русском в JSON не существует |
| Арабский текст | Uthmani script, quran.com API | Полный (6236 аятов, 114 сур) |
| Хранение истории | localStorage | Простота для MVP |
| Офлайн | Предзагрузка всего Корана при первом запуске | Высокая вероятность отсутствия WiFi в мечети |
| Хостинг | VPS 31.40.29.176, домен aniner.xyz/quran | Свой сервер |
| CI/CD | GitHub Actions → rsync на VPS | Автодеплой при push |

---

## Архитектура

```
┌─────────────────────────────────────┐
│           Web UI (JS/CSS)           │
│  ┌─────────────┐  ┌──────────────┐  │
│  │  Арабский   │  │   Микрофон   │  │
│  │ текст аята  │  │  Web Speech  │  │
│  │  (подсветка) │  │     API      │  │
│  ├─────────────┤  └──────┬───────┘  │
│  │   Тафсир    │         │          │
│  │  Ас-Саади   │         ▼          │
│  └─────────────┘  Распознанный      │
│        ▲          арабский текст    │
│        │               │            │
│  ┌─────┴───────────────┴─────────┐  │
│  │       Rust/WASM Core          │  │
│  │  • Fuzzy matching (bigram     │  │
│  │    Dice + position boost)     │  │
│  │  • Очистка ташкиля            │  │
│  │  • История чтений             │  │
│  └───────────────────────────────┘  │
│                                     │
│  JS Fallback (app-standalone.js)    │
│  — тот же алгоритм на чистом JS    │
│  — для работы без WASM-сборки      │
└─────────────────────────────────────┘
```

---

## Структура файлов

```
quran-tracker/
├── CLAUDE.md                    # Контекст для Claude Code
├── Cargo.toml                   # Rust проект (WASM)
├── Cargo.lock
│
├── src/                         # Rust ядро
│   ├── lib.rs                   # WASM API: QuranTracker, find_ayah, history
│   └── matching.rs              # Fuzzy matching: clean_arabic, bigram similarity
│
├── web/                         # Фронтенд (деплоится на VPS)
│   ├── index-mobile.html        # Главная страница (мобильная)
│   ├── app-standalone.js        # Вся логика: Speech API + matching + UI
│   ├── style.css                # Тёмная тема, крупный арабский шрифт
│   ├── index.html               # Версия с WASM
│   ├── app.js                   # WASM-версия app.js
│   └── data/
│       ├── quran_full.json      # 6236 аятов (3.6 MB), Arabic + Kuliev
│       └── quran.json           # 94 аята (сэмпл для тестов)
│
├── deploy/
│   ├── deploy.sh                # Ручной деплой через rsync
│   └── nginx.conf               # Конфиг nginx для aniner.xyz/quran
│
├── download_saadi.py            # Скачать тафсир Ас-Саади из spa5k CDN
├── fetch_quran_full.py          # Скачать полный Коран из quran.com API
├── build_quran_full.py          # Собрать quran_full.json из npm-пакета
│
├── .github/workflows/
│   ├── deploy.yml               # Автодеплой на VPS при push
│   └── fetch-data.yml           # Скачивание данных (ручной триггер)
│
└── .claude/
    ├── settings.json            # Хук SessionStart
    └── hooks/setup-env.sh       # Настройка окружения при старте сессии
```

---

## Текущий статус

### Готово
- [x] Rust/WASM ядро: fuzzy matching арабского текста (bigram Dice + position boost)
- [x] Очистка ташкиля (диакритики) для точного сравнения
- [x] Standalone JS-версия (работает без WASM-сборки)
- [x] Web UI: тёмная тема, арабский текст сверху + перевод снизу
- [x] Web Speech API: распознавание арабской речи через микрофон
- [x] Полные данные Корана: 6236 аятов, 114 сур, арабский (Uthmani)
- [x] Русский перевод Кулиева загружен в quran_full.json
- [x] История чтений в localStorage
- [x] GitHub Actions: deploy.yml (автодеплой) + fetch-data.yml (загрузка данных)
- [x] CLAUDE.md для контекста между сессиями
- [x] Конфиг nginx + скрипт деплоя

### Нужно сделать
- [ ] **Скачать тафсир Ас-Саади** — запустить `download_saadi.py` (нужен интернет)
- [ ] **Задеплоить на VPS** — `deploy/deploy.sh` или через GitHub Actions
- [ ] **Настроить nginx** на сервере для aniner.xyz/quran
- [ ] **Протестировать** распознавание речи с реальным чтением Корана
- [ ] **Интегрировать offline-tarteel** — ONNX модель для лучшего распознавания
- [ ] **Добавить навигацию по сурам** — выбор суры для подготовки к намазу
- [ ] **Добавить Service Worker** — полный офлайн-режим

---

## Как алгоритм matching работает

1. Микрофон → Web Speech API (lang: `ar-SA`) → распознанный арабский текст
2. Текст очищается от ташкиля (диакритических знаков: фатха, касра, дамма...)
3. Вычисляются биграммы (пары символов) для распознанного текста
4. Для каждого из 6236 аятов вычисляется коэффициент Дайса (Dice similarity)
5. К score прибавляется бонус позиции:
   - +0.15 если аят — следующий после текущего (последовательное чтение)
   - +0.05 если это текущий аят (повторное распознавание)
6. Если лучший score > 0.25 — показываем аят + перевод
7. Обновляем текущую позицию

---

## Данные

### quran_full.json (текущий — перевод Кулиева)
```json
{
  "surah": 1, "ayah": 1,
  "arabic": "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ",
  "translation": "Во имя Аллаха, Милостивого, Милосердного.",
  "surah_name_ar": "الفاتحة",
  "surah_name_ru": "Аль-Фатиха"
}
```

### Тафсир Ас-Саади (нужно скачать)
- Источник: `cdn.jsdelivr.net/gh/spa5k/tafsir_api@main/tafsir/ru-tafseer-al-saddi/{surah}.json`
- Скрипт: `download_saadi.py` — скачивает и заменяет поле `translation`
- 114 запросов (по одному на суру)

---

## VPS / Деплой

- **Сервер**: 31.40.29.176 (aniner.xyz)
- **Web root**: /var/www/quran-tracker/
- **URL**: https://aniner.xyz/quran/
- **Web server**: nginx
- **SSL**: certbot (Let's Encrypt)

### Nginx конфиг (deploy/nginx.conf)
```nginx
location /quran/ {
    alias /var/www/quran-tracker/;
    index index-mobile.html;
    try_files $uri $uri/ /quran/index-mobile.html;
}
```

### GitHub Secrets (нужно добавить)
| Secret | Значение |
|--------|----------|
| `VPS_USER` | Юзер SSH на сервере (например `root`) |
| `VPS_SSH_KEY` | Приватный SSH-ключ для деплоя |

---

## Ключевые открытия из исследования

1. **Tarteel AI не имеет публичного API** — но есть open-source offline-tarteel (ONNX модель, 87% точность, 116 MB, работает в браузере)
2. **Тафсир Ибн Касира на русском в JSON не существует** — есть только на арабском/английском. Альтернатива: Ас-Саади (русский, есть в JSON)
3. **Web Speech API** работает для арабского (lang: ar-SA) в Chrome и Safari, но точность средняя
4. **Claude Code sandbox** блокирует внешнюю сеть — решение через GitHub Actions

---

## Репозиторий

- **GitHub**: `ideali/texts`
- **Ветка с кодом**: `claude/quran-recitation-tracker-Y3KAt`
- **Ветка master**: только текстовые файлы (fin-us.md, ip-rus.md)
- **Коммиты проекта**:
  1. `5af3d18` — Rust/WASM прототип
  2. `d10ffb5` — Standalone JS для мобильного тестирования
  3. `42941ab` — Полные данные Корана (6236 аятов)
  4. `4470622` — Скрипт тафсира + конфиг деплоя
  5. `81b61f3` — GitHub Actions CI/CD
  6. `42a8be0` — SessionStart hook + CLAUDE.md

---

## Для новой сессии (rego/SSH)

```bash
# Склонировать и переключиться на нужную ветку
git clone https://github.com/ideali/texts.git
cd texts
git checkout claude/quran-recitation-tracker-Y3KAt

# Скачать тафсир Ас-Саади
cd quran-tracker
python3 download_saadi.py

# Задеплоить
chmod +x deploy/deploy.sh
./deploy/deploy.sh

# Или вручную
rsync -avz web/ root@31.40.29.176:/var/www/quran-tracker/
```
