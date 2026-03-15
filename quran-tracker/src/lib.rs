use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};

mod matching;

/// Single ayah with Arabic text and Russian translation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ayah {
    pub surah: u16,
    pub ayah: u16,
    pub arabic: String,
    pub translation: String,
    pub surah_name_ar: String,
    pub surah_name_ru: String,
}

/// Reading history entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub surah: u16,
    pub ayah_from: u16,
    pub ayah_to: u16,
    pub date: String,
}

/// Main tracker state exposed to JS via WASM
#[wasm_bindgen]
pub struct QuranTracker {
    ayahs: Vec<Ayah>,
    current_surah: u16,
    current_ayah: u16,
    history: Vec<HistoryEntry>,
    session_start_surah: u16,
    session_start_ayah: u16,
}

#[wasm_bindgen]
impl QuranTracker {
    /// Create a new tracker. `quran_json` is the full Quran data as JSON string.
    #[wasm_bindgen(constructor)]
    pub fn new(quran_json: &str) -> Result<QuranTracker, JsValue> {
        let ayahs: Vec<Ayah> = serde_json::from_str(quran_json)
            .map_err(|e| JsValue::from_str(&format!("Failed to parse Quran data: {}", e)))?;

        Ok(QuranTracker {
            ayahs,
            current_surah: 0,
            current_ayah: 0,
            history: Vec::new(),
            session_start_surah: 0,
            session_start_ayah: 0,
        })
    }

    /// Total number of ayahs loaded
    #[wasm_bindgen(getter)]
    pub fn total_ayahs(&self) -> usize {
        self.ayahs.len()
    }

    /// Find the best matching ayah for recognized Arabic text.
    /// Returns JSON: { surah, ayah, arabic, translation, surah_name_ar, surah_name_ru, score }
    #[wasm_bindgen]
    pub fn find_ayah(&mut self, recognized_text: &str) -> Result<JsValue, JsValue> {
        if recognized_text.trim().is_empty() {
            return Err(JsValue::from_str("Empty input"));
        }

        let cleaned = matching::clean_arabic(recognized_text);

        let mut best_idx = 0;
        let mut best_score: f64 = 0.0;

        for (i, ayah) in self.ayahs.iter().enumerate() {
            let ayah_cleaned = matching::clean_arabic(&ayah.arabic);
            let score = matching::similarity(&cleaned, &ayah_cleaned);

            // Boost score if this ayah is near current position (sequential reading)
            let position_boost = if self.current_surah > 0 {
                let is_next = ayah.surah == self.current_surah && ayah.ayah == self.current_ayah + 1;
                let is_current = ayah.surah == self.current_surah && ayah.ayah == self.current_ayah;
                if is_next { 0.15 } else if is_current { 0.05 } else { 0.0 }
            } else {
                0.0
            };

            let total = score + position_boost;
            if total > best_score {
                best_score = total;
                best_idx = i;
            }
        }

        // Minimum threshold to avoid false matches
        if best_score < 0.25 {
            return Err(JsValue::from_str("No confident match found"));
        }

        let matched = &self.ayahs[best_idx];

        // Update current position
        if self.current_surah == 0 {
            self.session_start_surah = matched.surah;
            self.session_start_ayah = matched.ayah;
        }
        self.current_surah = matched.surah;
        self.current_ayah = matched.ayah;

        let result = serde_json::json!({
            "surah": matched.surah,
            "ayah": matched.ayah,
            "arabic": matched.arabic,
            "translation": matched.translation,
            "surah_name_ar": matched.surah_name_ar,
            "surah_name_ru": matched.surah_name_ru,
            "score": best_score,
        });

        Ok(JsValue::from_str(&result.to_string()))
    }

    /// Get ayah by surah and ayah number. Returns JSON.
    #[wasm_bindgen]
    pub fn get_ayah(&self, surah: u16, ayah: u16) -> Result<JsValue, JsValue> {
        let found = self.ayahs.iter().find(|a| a.surah == surah && a.ayah == ayah);
        match found {
            Some(a) => {
                let result = serde_json::json!({
                    "surah": a.surah,
                    "ayah": a.ayah,
                    "arabic": a.arabic,
                    "translation": a.translation,
                    "surah_name_ar": a.surah_name_ar,
                    "surah_name_ru": a.surah_name_ru,
                });
                Ok(JsValue::from_str(&result.to_string()))
            }
            None => Err(JsValue::from_str("Ayah not found")),
        }
    }

    /// Get all ayahs of a surah as JSON array
    #[wasm_bindgen]
    pub fn get_surah(&self, surah: u16) -> Result<JsValue, JsValue> {
        let ayahs: Vec<_> = self.ayahs.iter()
            .filter(|a| a.surah == surah)
            .map(|a| serde_json::json!({
                "surah": a.surah,
                "ayah": a.ayah,
                "arabic": a.arabic,
                "translation": a.translation,
            }))
            .collect();

        if ayahs.is_empty() {
            return Err(JsValue::from_str("Surah not found"));
        }

        Ok(JsValue::from_str(&serde_json::to_string(&ayahs).unwrap()))
    }

    /// End current session and return history entry as JSON
    #[wasm_bindgen]
    pub fn end_session(&mut self, date: &str) -> Result<JsValue, JsValue> {
        if self.current_surah == 0 {
            return Err(JsValue::from_str("No active session"));
        }

        let entry = HistoryEntry {
            surah: self.session_start_surah,
            ayah_from: self.session_start_ayah,
            ayah_to: self.current_ayah,
            date: date.to_string(),
        };

        let json = serde_json::to_string(&entry).unwrap();
        self.history.push(entry);

        // Reset session
        self.current_surah = 0;
        self.current_ayah = 0;
        self.session_start_surah = 0;
        self.session_start_ayah = 0;

        Ok(JsValue::from_str(&json))
    }

    /// Get current position as JSON
    #[wasm_bindgen]
    pub fn current_position(&self) -> JsValue {
        let result = serde_json::json!({
            "surah": self.current_surah,
            "ayah": self.current_ayah,
        });
        JsValue::from_str(&result.to_string())
    }
}
