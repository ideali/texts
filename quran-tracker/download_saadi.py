#!/usr/bin/env python3
"""
Download As-Saadi tafsir (Russian) from spa5k/tafsir_api CDN
and merge it into quran_full.json, replacing Kuliev translation.

Usage: python3 download_saadi.py
"""

import json
import os
import sys
import time
import urllib.request

BASE_URL = "https://cdn.jsdelivr.net/gh/spa5k/tafsir_api@main/tafsir/ru-tafseer-al-saddi"
DATA_DIR = os.path.join(os.path.dirname(__file__), "web", "data")
QURAN_FILE = os.path.join(DATA_DIR, "quran_full.json")
OUTPUT_FILE = QURAN_FILE  # overwrite in place

# Expected ayah counts per surah
AYAH_COUNTS = {
    1:7,2:286,3:200,4:176,5:120,6:165,7:206,8:75,9:129,10:109,
    11:123,12:111,13:43,14:52,15:99,16:128,17:111,18:110,19:98,
    20:135,21:112,22:78,23:118,24:64,25:77,26:227,27:93,28:88,
    29:69,30:60,31:34,32:30,33:73,34:54,35:45,36:83,37:182,38:88,
    39:75,40:85,41:54,42:53,43:89,44:59,45:37,46:35,47:38,48:29,
    49:18,50:45,51:60,52:49,53:62,54:55,55:78,56:96,57:29,58:22,
    59:24,60:13,61:14,62:11,63:11,64:18,65:12,66:12,67:30,68:52,
    69:52,70:44,71:28,72:28,73:20,74:56,75:40,76:31,77:50,78:40,
    79:46,80:42,81:29,82:19,83:36,84:25,85:22,86:17,87:19,88:26,
    89:30,90:20,91:15,92:21,93:11,94:8,95:8,96:19,97:5,98:8,
    99:8,100:11,101:11,102:8,103:3,104:9,105:5,106:4,107:7,108:3,
    109:6,110:3,111:5,112:4,113:5,114:6
}


def download_surah(surah_num, retries=3):
    """Download tafsir for one surah from CDN."""
    url = f"{BASE_URL}/{surah_num}.json"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            data = urllib.request.urlopen(req, timeout=30).read()
            return json.loads(data)
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            else:
                print(f"  FAILED surah {surah_num}: {e}")
                return None


def main():
    # Load existing quran data
    print(f"Loading {QURAN_FILE}...")
    with open(QURAN_FILE, "r", encoding="utf-8") as f:
        quran = json.load(f)

    # Build lookup: (surah, ayah) -> index
    lookup = {}
    for i, ayah in enumerate(quran):
        lookup[(ayah["surah"], ayah["ayah"])] = i

    # Download all 114 surahs
    total_updated = 0
    total_missing = 0

    for surah_num in range(1, 115):
        print(f"Downloading surah {surah_num}/114...", end=" ", flush=True)
        data = download_surah(surah_num)

        if data is None:
            print("SKIPPED")
            continue

        # The spa5k API returns either:
        # - A dict with "tafsirs" key containing list of {ayah_number, text}
        # - Or a dict with "result" key
        # - Or a list directly
        tafsirs = []
        if isinstance(data, dict):
            if "tafsirs" in data:
                tafsirs = data["tafsirs"]
            elif "result" in data:
                tafsirs = data["result"]
            elif "ayahs" in data:
                tafsirs = data["ayahs"]
            else:
                # Try the dict values
                for key in data:
                    if isinstance(data[key], list):
                        tafsirs = data[key]
                        break
        elif isinstance(data, list):
            tafsirs = data

        count = 0
        for item in tafsirs:
            ayah_num = item.get("ayah_number") or item.get("ayah") or item.get("verse_number")
            text = item.get("text") or item.get("tafsir_text") or item.get("translation")

            if ayah_num and text:
                key = (surah_num, int(ayah_num))
                if key in lookup:
                    idx = lookup[key]
                    # Replace Kuliev translation with As-Saadi tafsir
                    quran[idx]["translation"] = text.strip()
                    count += 1

        total_updated += count
        expected = AYAH_COUNTS.get(surah_num, 0)
        if count < expected:
            total_missing += (expected - count)
            print(f"{count}/{expected} ayahs")
        else:
            print(f"OK ({count} ayahs)")

    print(f"\nTotal updated: {total_updated}/6236")
    if total_missing:
        print(f"Missing: {total_missing} ayahs (kept original Kuliev)")

    # Save
    print(f"Saving to {OUTPUT_FILE}...")
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(quran, f, ensure_ascii=False, indent=2)

    print("Done!")


if __name__ == "__main__":
    main()
