/// Clean Arabic text: remove diacritics (tashkeel), normalize whitespace
pub fn clean_arabic(text: &str) -> String {
    text.chars()
        .filter(|c| !is_arabic_diacritic(*c))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Check if character is an Arabic diacritic (tashkeel)
fn is_arabic_diacritic(c: char) -> bool {
    matches!(c as u32,
        0x0610..=0x061A |  // Various signs
        0x064B..=0x065F |  // Fathatan through Wavy Hamza Below
        0x0670           |  // Superscript Alef
        0x06D6..=0x06DC |  // Small high ligatures
        0x06DF..=0x06E4 |  // Small high rounded zero etc.
        0x06E7..=0x06E8 |  // Small high yeh/noon
        0x06EA..=0x06ED    // Empty centre low/high stop
    )
}

/// Compute similarity between two Arabic strings (0.0 - 1.0).
/// Uses bigram-based Dice coefficient — fast and effective for fuzzy matching.
pub fn similarity(a: &str, b: &str) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }

    let bigrams_a = bigrams(a);
    let bigrams_b = bigrams(b);

    if bigrams_a.is_empty() && bigrams_b.is_empty() {
        // Single character comparison
        return if a == b { 1.0 } else { 0.0 };
    }

    let mut matches = 0;
    let mut used = vec![false; bigrams_b.len()];

    for ba in &bigrams_a {
        for (j, bb) in bigrams_b.iter().enumerate() {
            if !used[j] && ba == bb {
                matches += 1;
                used[j] = true;
                break;
            }
        }
    }

    (2 * matches) as f64 / (bigrams_a.len() + bigrams_b.len()) as f64
}

/// Extract character bigrams from a string
fn bigrams(s: &str) -> Vec<(char, char)> {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() < 2 {
        return vec![];
    }
    chars.windows(2).map(|w| (w[0], w[1])).collect()
}

/// Substring match: check if recognized text is a substring of ayah (partial recitation)
pub fn contains_match(recognized: &str, ayah_text: &str) -> f64 {
    let r = clean_arabic(recognized);
    let a = clean_arabic(ayah_text);

    if r.is_empty() || a.is_empty() {
        return 0.0;
    }

    if a.contains(&r) {
        r.len() as f64 / a.len() as f64
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_arabic() {
        // بِسْمِ should become بسم after removing diacritics
        let input = "بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ";
        let cleaned = clean_arabic(input);
        assert!(!cleaned.contains('\u{0650}')); // kasra
        assert!(!cleaned.contains('\u{0652}')); // sukun
    }

    #[test]
    fn test_similarity_identical() {
        let score = similarity("بسم الله", "بسم الله");
        assert!((score - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_similarity_different() {
        let score = similarity("بسم الله", "قل هو الله");
        assert!(score < 0.7);
    }

    #[test]
    fn test_similarity_empty() {
        assert_eq!(similarity("", "test"), 0.0);
        assert_eq!(similarity("test", ""), 0.0);
    }
}
