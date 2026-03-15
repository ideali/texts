#!/usr/bin/env python3
"""Build quran_full.json from local npm quran-json package data."""

import json

BASE = "/home/user/texts/quran-tracker/node_modules/quran-json/dist"
OUTPUT = "/home/user/texts/quran-tracker/web/data/quran_full.json"

SURAH_NAMES_RU = {
    1: "Аль-Фатиха", 2: "Аль-Бакара", 3: "Аль Имран", 4: "Ан-Ниса",
    5: "Аль-Маида", 6: "Аль-Анам", 7: "Аль-Араф", 8: "Аль-Анфаль",
    9: "Ат-Тауба", 10: "Юнус", 11: "Худ", 12: "Юсуф",
    13: "Ар-Раад", 14: "Ибрахим", 15: "Аль-Хиджр", 16: "Ан-Нахль",
    17: "Аль-Исра", 18: "Аль-Кахф", 19: "Марьям", 20: "Та Ха",
    21: "Аль-Анбия", 22: "Аль-Хадж", 23: "Аль-Муминун", 24: "Ан-Нур",
    25: "Аль-Фуркан", 26: "Аш-Шуара", 27: "Ан-Намль", 28: "Аль-Касас",
    29: "Аль-Анкабут", 30: "Ар-Рум", 31: "Лукман", 32: "Ас-Саджда",
    33: "Аль-Ахзаб", 34: "Саба", 35: "Фатыр", 36: "Йа Син",
    37: "Ас-Саффат", 38: "Сад", 39: "Аз-Зумар", 40: "Гафир",
    41: "Фуссилят", 42: "Аш-Шура", 43: "Аз-Зухруф", 44: "Ад-Духан",
    45: "Аль-Джасия", 46: "Аль-Ахкаф", 47: "Мухаммад", 48: "Аль-Фатх",
    49: "Аль-Худжурат", 50: "Каф", 51: "Аз-Зарият", 52: "Ат-Тур",
    53: "Ан-Наджм", 54: "Аль-Камар", 55: "Ар-Рахман", 56: "Аль-Вакиа",
    57: "Аль-Хадид", 58: "Аль-Муджадила", 59: "Аль-Хашр", 60: "Аль-Мумтахана",
    61: "Ас-Сафф", 62: "Аль-Джумуа", 63: "Аль-Мунафикун", 64: "Ат-Тагабун",
    65: "Ат-Талак", 66: "Ат-Тахрим", 67: "Аль-Мульк", 68: "Аль-Калям",
    69: "Аль-Хакка", 70: "Аль-Мааридж", 71: "Нух", 72: "Аль-Джинн",
    73: "Аль-Муззаммиль", 74: "Аль-Муддассир", 75: "Аль-Кияма", 76: "Аль-Инсан",
    77: "Аль-Мурсалят", 78: "Ан-Наба", 79: "Ан-Назиат", 80: "Абаса",
    81: "Ат-Таквир", 82: "Аль-Инфитар", 83: "Аль-Мутаффифин", 84: "Аль-Иншикак",
    85: "Аль-Бурудж", 86: "Ат-Тарик", 87: "Аль-Аля", 88: "Аль-Гашия",
    89: "Аль-Фаджр", 90: "Аль-Балад", 91: "Аш-Шамс", 92: "Аль-Лейль",
    93: "Ад-Духа", 94: "Аш-Шарх", 95: "Ат-Тин", 96: "Аль-Алак",
    97: "Аль-Кадр", 98: "Аль-Баййина", 99: "Аз-Зальзала", 100: "Аль-Адият",
    101: "Аль-Кариа", 102: "Ат-Такасур", 103: "Аль-Аср", 104: "Аль-Хумаза",
    105: "Аль-Филь", 106: "Курайш", 107: "Аль-Маун", 108: "Аль-Каусар",
    109: "Аль-Кафирун", 110: "Ан-Наср", 111: "Аль-Масад", 112: "Аль-Ихлас",
    113: "Аль-Фалак", 114: "Ан-Нас",
}

def main():
    # Load Arabic source
    with open(f"{BASE}/quran.json", encoding="utf-8") as f:
        arabic_data = json.load(f)

    # Load Russian translation source
    with open(f"{BASE}/quran_ru.json", encoding="utf-8") as f:
        russian_data = json.load(f)

    # Build Russian lookup: (surah_id, verse_id) -> translation
    ru_lookup = {}
    for surah in russian_data:
        sid = surah["id"]
        for v in surah["verses"]:
            ru_lookup[(sid, v["id"])] = v.get("translation", "")

    # Build result
    result = []
    for surah in arabic_data:
        sid = surah["id"]
        surah_name_ar = surah["name"]
        surah_name_ru = SURAH_NAMES_RU.get(sid, "")
        for v in surah["verses"]:
            vid = v["id"]
            result.append({
                "surah": sid,
                "ayah": vid,
                "arabic": v["text"],
                "translation": ru_lookup.get((sid, vid), ""),
                "surah_name_ar": surah_name_ar,
                "surah_name_ru": surah_name_ru,
            })

    print(f"Total ayahs: {len(result)}")
    print(f"First: {json.dumps(result[0], ensure_ascii=False)[:200]}")
    print(f"Last: {json.dumps(result[-1], ensure_ascii=False)[:200]}")

    # Check for missing translations
    missing = sum(1 for r in result if not r["translation"])
    if missing:
        print(f"WARNING: {missing} ayahs missing Russian translation")

    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    import os
    size = os.path.getsize(OUTPUT)
    print(f"Saved to {OUTPUT} ({size:,} bytes)")

if __name__ == "__main__":
    main()
