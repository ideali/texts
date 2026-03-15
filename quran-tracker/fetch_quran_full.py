#!/usr/bin/env python3
"""Fetch full Quran data (6236 ayahs) with Arabic text and Russian (Kuliev) translation."""

import json
import urllib.request
import urllib.error
import time
import sys
import re

OUTPUT_FILE = "/home/user/texts/quran-tracker/web/data/quran_full.json"

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


def fetch_url(url, timeout=30):
    """Fetch URL content."""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    resp = urllib.request.urlopen(req, timeout=timeout)
    return resp.read().decode("utf-8")


def fetch_arabic():
    """Fetch Arabic text from quran-json CDN."""
    print("Fetching Arabic text from CDN...")
    url = "https://cdn.jsdelivr.net/npm/quran-json@3.1.2/dist/quran.json"
    data = json.loads(fetch_url(url, timeout=60))
    print(f"  Got {len(data)} surahs")
    # Build dict: (surah, ayah) -> { arabic, surah_name_ar }
    arabic = {}
    for surah in data:
        surah_num = surah.get("id") or surah.get("number") or int(surah.get("index", 0))
        surah_name_ar = surah.get("name", "")
        verses = surah.get("verses") or surah.get("ayahs") or surah.get("array") or []
        for v in verses:
            ayah_num = v.get("id") or v.get("number") or v.get("index")
            text = v.get("text", "")
            arabic[(surah_num, ayah_num)] = {"arabic": text, "surah_name_ar": surah_name_ar}
    print(f"  Parsed {len(arabic)} ayahs")
    return arabic


def fetch_russian_qurancom():
    """Fetch Russian (Kuliev) translation from Quran.com API, paginated."""
    print("Fetching Russian translation from Quran.com API...")
    russian = {}
    # The API returns translations paginated. We need to fetch all pages.
    # translations/45 is Kuliev. We fetch per-surah for reliability.
    for surah_num in range(1, 115):
        url = f"https://api.quran.com/api/v4/quran/translations/45?chapter_number={surah_num}"
        try:
            data = json.loads(fetch_url(url, timeout=30))
            translations = data.get("translations", [])
            for t in translations:
                verse_key = t.get("verse_key", "")
                if ":" in verse_key:
                    s, a = verse_key.split(":")
                    text = t.get("text", "")
                    # Remove HTML tags if present
                    text = re.sub(r'<[^>]+>', '', text)
                    russian[(int(s), int(a))] = text
            if surah_num % 10 == 0:
                print(f"  Fetched surah {surah_num}/114 ({len(russian)} ayahs so far)")
        except Exception as e:
            print(f"  Error fetching surah {surah_num}: {e}")
        time.sleep(0.1)  # Rate limiting
    print(f"  Total Russian ayahs: {len(russian)}")
    return russian


def fetch_russian_jsdelivr():
    """Try fetching Russian translation from jsdelivr GitHub mirror."""
    print("Trying Russian translation from jsdelivr GitHub...")
    url = "https://cdn.jsdelivr.net/gh/nicefeel/quran-json-data@master/quran_ru.json"
    try:
        data = json.loads(fetch_url(url, timeout=60))
        russian = {}
        if isinstance(data, list):
            for item in data:
                s = item.get("surah") or item.get("chapter")
                a = item.get("ayah") or item.get("verse") or item.get("aya")
                t = item.get("text") or item.get("translation") or item.get("content")
                if s and a and t:
                    russian[(int(s), int(a))] = t
        elif isinstance(data, dict):
            for key, val in data.items():
                if isinstance(val, list):
                    for item in val:
                        s = item.get("surah") or item.get("chapter") or item.get("id")
                        a = item.get("ayah") or item.get("verse") or item.get("aya")
                        t = item.get("text") or item.get("translation") or item.get("content")
                        if s and a and t:
                            russian[(int(s), int(a))] = t
                elif isinstance(val, dict):
                    # Could be surah-keyed
                    for akey, aval in val.items():
                        if isinstance(aval, str):
                            russian[(int(key), int(akey))] = aval
        print(f"  Got {len(russian)} ayahs from jsdelivr")
        return russian
    except Exception as e:
        print(f"  jsdelivr failed: {e}")
        return {}


def fetch_russian_fawazahmed():
    """Try fetching Russian translation from fawazahmed0's API."""
    print("Trying Russian translation from fawazahmed0...")
    urls = [
        "https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/rus-abuadel.json",
        "https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/rus-islamicfoundati.json",
        "https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/rus-kuliev.json",
        "https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/rus-kuliev-alsaadi.json",
    ]
    for url in urls:
        try:
            print(f"  Trying {url.split('/')[-1]}...")
            raw = fetch_url(url, timeout=60)
            data = json.loads(raw)
            russian = {}
            # Format: { "quran": [ { "chapter": N, "verse": N, "text": "..." }, ... ] }
            quran_data = data.get("quran", data)
            if isinstance(quran_data, list):
                for item in quran_data:
                    s = item.get("chapter")
                    a = item.get("verse")
                    t = item.get("text", "")
                    if s and a and t:
                        russian[(int(s), int(a))] = t
            if len(russian) > 6000:
                print(f"  Got {len(russian)} ayahs!")
                return russian
            else:
                print(f"  Only got {len(russian)} ayahs, trying next...")
        except Exception as e:
            print(f"  Failed: {e}")
    return {}


def main():
    # Step 1: Fetch Arabic
    try:
        arabic = fetch_arabic()
    except Exception as e:
        print(f"Failed to fetch Arabic: {e}")
        sys.exit(1)

    if len(arabic) < 6000:
        print(f"WARNING: Only got {len(arabic)} Arabic ayahs, expected ~6236")

    # Step 2: Fetch Russian translation - try multiple sources
    russian = {}

    # Try fawazahmed0 first (single request, likely fast)
    russian = fetch_russian_fawazahmed()

    # Try jsdelivr if needed
    if len(russian) < 6000:
        russian2 = fetch_russian_jsdelivr()
        if len(russian2) > len(russian):
            russian = russian2

    # Fall back to Quran.com API (slower, per-surah)
    if len(russian) < 6000:
        russian2 = fetch_russian_qurancom()
        if len(russian2) > len(russian):
            russian = russian2

    if len(russian) < 6000:
        print(f"WARNING: Only got {len(russian)} Russian ayahs, expected ~6236")

    # Step 3: Combine
    print("\nCombining data...")
    result = []
    # Sort by (surah, ayah)
    all_keys = sorted(arabic.keys())
    missing_ru = 0
    for (surah_num, ayah_num) in all_keys:
        ar_data = arabic[(surah_num, ayah_num)]
        ru_text = russian.get((surah_num, ayah_num), "")
        if not ru_text:
            missing_ru += 1
        entry = {
            "surah": surah_num,
            "ayah": ayah_num,
            "arabic": ar_data["arabic"],
            "translation": ru_text,
            "surah_name_ar": ar_data["surah_name_ar"],
            "surah_name_ru": SURAH_NAMES_RU.get(surah_num, ""),
        }
        result.append(entry)

    if missing_ru > 0:
        print(f"WARNING: {missing_ru} ayahs missing Russian translation")

    print(f"Total ayahs: {len(result)}")
    print(f"First: surah {result[0]['surah']}, ayah {result[0]['ayah']}")
    print(f"Last: surah {result[-1]['surah']}, ayah {result[-1]['ayah']}")

    # Step 4: Write output
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"\nSaved to {OUTPUT_FILE}")
    print(f"File size: {len(json.dumps(result, ensure_ascii=False)):,} bytes")


if __name__ == "__main__":
    main()
