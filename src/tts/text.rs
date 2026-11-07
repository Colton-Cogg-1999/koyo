//! Prepares book text for speech: sentence boundaries with UTF-16 offsets for read-along,
//! and normalization of the things a phonemizer reads badly.

use regex::{Captures, Regex};
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq)]
pub struct Sentence {
    /// UTF-16 offsets into the block text, matching DOM ranges.
    pub start: u32,
    pub end: u32,
    pub text: String,
}

const ABBREVIATIONS: &[&str] = &[
    "mr", "mrs", "ms", "dr", "prof", "st", "sr", "jr", "vs", "etc", "e.g", "i.e", "no", "fig", "vol", "ch", "ed", "gen",
    "col", "capt", "lt", "sgt", "rev", "hon", "mt", "cf", "pp", "p",
];
const MAX_CHUNK: usize = 320;

fn is_boundary(chars: &[char], i: usize) -> bool {
    let c = chars[i];
    if !matches!(c, '.' | '?' | '!' | '…') {
        return false;
    }
    let mut j = i + 1;
    while j < chars.len() && matches!(chars[j], '"' | '\'' | '”' | '’' | ')' | ']' | '.' | '?' | '!') {
        j += 1;
    }
    if j >= chars.len() {
        return true;
    }
    if !chars[j].is_whitespace() {
        return false;
    }
    while j < chars.len() && chars[j].is_whitespace() {
        j += 1;
    }
    let next = chars.get(j).copied().unwrap_or('A');
    if next.is_lowercase() {
        return false;
    }
    if c == '.' {
        let mut k = i;
        while k > 0 && !chars[k - 1].is_whitespace() && !matches!(chars[k - 1], '(' | '"' | '“' | '‘') {
            k -= 1;
        }
        let word: String = chars[k..i].iter().collect::<String>().to_lowercase();
        if ABBREVIATIONS.contains(&word.as_str()) {
            return false;
        }
        if word.chars().count() == 1 && word.chars().all(char::is_alphabetic) {
            return false;
        }
    }
    true
}

fn utf16_len(chars: &[char]) -> u32 {
    chars.iter().map(|c| c.len_utf16() as u32).sum()
}

fn split_long(chars: &[char], base: u32, out: &mut Vec<Sentence>) {
    let mut start = 0usize;
    while start < chars.len() {
        let remaining = chars.len() - start;
        let mut end = chars.len();
        if remaining > MAX_CHUNK {
            let window = &chars[start..start + MAX_CHUNK];
            let cut = |set: &[char]| window.iter().rposition(|c| set.contains(c)).filter(|p| *p > 60);
            end = start + cut(&[';', ':', '—', '–']).or(cut(&[','])).or(cut(&[' '])).map(|p| p + 1).unwrap_or(MAX_CHUNK);
        }
        let piece: String = chars[start..end].iter().collect();
        if piece.chars().any(char::is_alphanumeric) {
            let lead = chars[start..end].iter().take_while(|c| c.is_whitespace()).count();
            let trail = chars[start..end].iter().rev().take_while(|c| c.is_whitespace()).count();
            let s = base + utf16_len(&chars[..start + lead]);
            let e = base + utf16_len(&chars[..end - trail]);
            out.push(Sentence { start: s, end: e, text: piece.trim().to_string() });
        }
        start = end;
    }
}

/// Splits into speakable sentences. Text inside a footnote mask (spaces) stays out of
/// the spoken string while the offsets remain valid for highlighting.
pub fn sentences(text: &str) -> Vec<Sentence> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut start = 0usize;
    for i in 0..chars.len() {
        if is_boundary(&chars, i) {
            let mut end = i + 1;
            while end < chars.len() && matches!(chars[end], '"' | '\'' | '”' | '’' | ')' | ']' | '.' | '?' | '!') {
                end += 1;
            }
            if end > start && i + 1 >= start {
                let base = utf16_len(&chars[..start]);
                split_long(&chars[start..end], base, &mut out);
                start = end;
            }
        }
    }
    if start < chars.len() {
        let base = utf16_len(&chars[..start]);
        split_long(&chars[start..], base, &mut out);
    }
    out
}

const ONES: [&str; 20] = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
    "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS: [&str; 10] = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

pub fn cardinal(n: u64) -> String {
    match n {
        0..=19 => ONES[n as usize].to_string(),
        20..=99 => {
            let tens = TENS[(n / 10) as usize];
            if n % 10 == 0 { tens.to_string() } else { format!("{tens}-{}", ONES[(n % 10) as usize]) }
        }
        100..=999 => {
            let rest = n % 100;
            let head = format!("{} hundred", ONES[(n / 100) as usize]);
            if rest == 0 { head } else { format!("{head} {}", cardinal(rest)) }
        }
        _ => {
            for (value, name) in [(1_000_000_000_000u64, "trillion"), (1_000_000_000, "billion"), (1_000_000, "million"), (1_000, "thousand")] {
                if n >= value {
                    let rest = n % value;
                    let head = format!("{} {name}", cardinal(n / value));
                    return if rest == 0 { head } else { format!("{head} {}", cardinal(rest)) };
                }
            }
            String::new()
        }
    }
}

pub fn ordinal(n: u64) -> String {
    let word = cardinal(n);
    let (head, last) = match word.rfind([' ', '-']) {
        Some(p) => word.split_at(p + 1),
        None => ("", word.as_str()),
    };
    let tail = match last {
        "one" => "first".to_string(),
        "two" => "second".to_string(),
        "three" => "third".to_string(),
        "five" => "fifth".to_string(),
        "eight" => "eighth".to_string(),
        "nine" => "ninth".to_string(),
        "twelve" => "twelfth".to_string(),
        other if other.ends_with('y') => format!("{}ieth", &other[..other.len() - 1]),
        other => format!("{other}th"),
    };
    format!("{head}{tail}")
}

pub fn year(y: u64) -> String {
    match y {
        2000 => "two thousand".into(),
        2001..=2009 => format!("two thousand {}", cardinal(y - 2000)),
        _ => {
            let (hi, lo) = (y / 100, y % 100);
            match lo {
                0 => format!("{} hundred", cardinal(hi)),
                1..=9 => format!("{} oh {}", cardinal(hi), cardinal(lo)),
                _ => format!("{} {}", cardinal(hi), cardinal(lo)),
            }
        }
    }
}

fn roman(s: &str) -> Option<u64> {
    let value = |c| match c {
        'I' => Some(1),
        'V' => Some(5),
        'X' => Some(10),
        'L' => Some(50),
        'C' => Some(100),
        'D' => Some(500),
        'M' => Some(1000),
        _ => None,
    };
    let mut total = 0i64;
    let digits: Vec<i64> = s.chars().map(value).collect::<Option<_>>()?;
    for (i, d) in digits.iter().enumerate() {
        total += if digits.get(i + 1).is_some_and(|next| next > d) { -d } else { *d };
    }
    (total > 0).then_some(total as u64)
}

static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(https?://|www\.)\S+").unwrap());
static REF_MARK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[\d{1,3}\]").unwrap());
static CURRENCY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([$£€])(\d[\d,]*)(?:\.(\d{2}))?\b").unwrap());
static PERCENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d)\s?%").unwrap());
static DECADE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(1[0-9]|20)(\d)0s\b").unwrap());
static ORDINAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(\d{1,4})(st|nd|rd|th)\b").unwrap());
static CHAPTER_ROMAN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(Chapter|CHAPTER|Book|BOOK|Part|PART|Section|Volume|Act|Canto)\s+([IVXLCDM]+)\b").unwrap());
static SHOUTING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b[A-Z][A-Z'’]{2,}\b").unwrap());
static DECIMAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(\d+)\.(\d+)\b").unwrap());
static NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b\d[\d,]*\b").unwrap());
static RANGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(\d+)[–—-](\d+)\b").unwrap());

fn number_word(raw: &str) -> String {
    let digits: String = raw.chars().filter(char::is_ascii_digit).collect();
    if digits.len() > 15 {
        return digits.chars().map(|c| ONES[c as usize - 48]).collect::<Vec<_>>().join(" ");
    }
    let Ok(value) = digits.parse::<u64>() else { return raw.to_string() };
    if !raw.contains(',') && digits.len() == 4 && (1100..=2099).contains(&value) {
        return year(value);
    }
    cardinal(value)
}

pub fn normalize(text: &str) -> String {
    let mut s = text
        .replace(['“', '”', '„'], "\"")
        .replace(['‘', '’'], "'")
        .replace(['—', '―'], ", ")
        .replace('…', "...")
        .replace('\u{a0}', " ");
    for (from, to) in [
        ("Mr. ", "Mister "),
        ("Mrs. ", "Missus "),
        ("Ms. ", "Miz "),
        ("Dr. ", "Doctor "),
        ("Prof. ", "Professor "),
        ("St. ", "Saint "),
        ("e.g.", "for example"),
        ("i.e.", "that is"),
        ("etc.", "et cetera"),
        (" vs. ", " versus "),
        ("No. ", "number "),
        ("Fig. ", "figure "),
        (" & ", " and "),
    ] {
        s = s.replace(from, to);
    }
    let s = REF_MARK.replace_all(&s, "");
    let s = URL.replace_all(&s, "link");
    let s = CHAPTER_ROMAN.replace_all(&s, |c: &Captures| {
        roman(&c[2]).map(|n| format!("{} {}", &c[1], cardinal(n))).unwrap_or_else(|| c[0].to_string())
    });
    let s = CURRENCY.replace_all(&s, |c: &Captures| {
        let (unit, minor) = match &c[1] {
            "$" => ("dollars", "cents"),
            "£" => ("pounds", "pence"),
            _ => ("euros", "cents"),
        };
        let whole = cardinal(c[2].replace(',', "").parse().unwrap_or(0));
        match c.get(3).map(|m| m.as_str().parse::<u64>().unwrap_or(0)) {
            Some(value) if value > 0 => format!("{whole} {unit} and {} {minor}", cardinal(value)),
            _ => format!("{whole} {unit}"),
        }
    });
    let s = PERCENT.replace_all(&s, "$1 percent");
    let s = DECADE.replace_all(&s, |c: &Captures| {
        let decade: u64 = c[2].parse().unwrap_or(0);
        let hi: u64 = c[1].parse().unwrap_or(19);
        let word = if decade == 0 { "hundreds".to_string() } else { cardinal(decade * 10).replace('y', "ies") };
        format!("{} {word}", cardinal(hi))
    });
    let s = ORDINAL.replace_all(&s, |c: &Captures| ordinal(c[1].parse().unwrap_or(0)));
    let s = RANGE.replace_all(&s, |c: &Captures| format!("{} to {}", number_word(&c[1]), number_word(&c[2])));
    let s = DECIMAL.replace_all(&s, |c: &Captures| {
        let fraction = c[2].chars().map(|d| ONES[d as usize - 48]).collect::<Vec<_>>().join(" ");
        format!("{} point {fraction}", number_word(&c[1]))
    });
    let s = NUMBER.replace_all(&s, |c: &Captures| number_word(&c[0]));
    let s = SHOUTING.replace_all(&s, |c: &Captures| {
        let word = &c[0];
        if word.chars().any(|ch| "AEIOUY".contains(ch)) { word.to_lowercase() } else { word.to_string() }
    });
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A heading that is only a Roman numeral is a chapter number, not the letters "I V".
pub fn normalize_heading(text: &str) -> String {
    let bare = text.trim().trim_end_matches('.');
    if let Some(number) = roman(bare) {
        return format!("Chapter {}.", cardinal(number));
    }
    let spoken = normalize(text);
    if spoken.ends_with(['.', '?', '!', ':']) { spoken } else { format!("{spoken}.") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_sentences_with_offsets() {
        let text = "Mr. Smith arrived. He said “hello!” Then he left.";
        let got = sentences(text);
        assert_eq!(got.len(), 3, "{got:?}");
        assert_eq!(got[0].text, "Mr. Smith arrived.");
        assert_eq!(got[1].text, "He said “hello!”");
        let units: Vec<u16> = text.encode_utf16().collect();
        let slice = String::from_utf16_lossy(&units[got[2].start as usize..got[2].end as usize]);
        assert_eq!(slice, "Then he left.");
    }

    #[test]
    fn offsets_count_utf16_units() {
        let text = "📖 First one. Second one.";
        let got = sentences(text);
        let units: Vec<u16> = text.encode_utf16().collect();
        let slice = String::from_utf16_lossy(&units[got[1].start as usize..got[1].end as usize]);
        assert_eq!(slice, "Second one.");
    }

    #[test]
    fn long_sentences_are_bounded() {
        let text = "word, ".repeat(200);
        let got = sentences(&text);
        assert!(got.len() > 1);
        assert!(got.iter().all(|s| s.text.chars().count() <= MAX_CHUNK));
    }

    #[test]
    fn numbers_become_words() {
        assert_eq!(cardinal(1234), "one thousand two hundred thirty-four");
        assert_eq!(ordinal(21), "twenty-first");
        assert_eq!(ordinal(40), "fortieth");
        assert_eq!(year(1984), "nineteen eighty-four");
        assert_eq!(year(1905), "nineteen oh five");
        assert_eq!(normalize("In 1984, it cost $3.50 for 12 books."), "In nineteen eighty-four, it cost three dollars and fifty cents for twelve books.");
        assert_eq!(normalize("the 1960s and the 3rd of 1,200"), "the nineteen sixties and the third of one thousand two hundred");
        assert_eq!(normalize("pages 12-15, 3.14 and 50%"), "pages twelve to fifteen, three point one four and fifty percent");
    }

    #[test]
    fn expands_words_that_read_badly() {
        assert_eq!(normalize("Dr. Who, see Chapter IV[12]."), "Doctor Who, see Chapter four.");
        assert_eq!(normalize("THE SONG of NASA"), "the song of nasa");
        assert_eq!(normalize("TRY THE SKY, BBC and TV"), "try the sky, BBC and TV");
        assert_eq!(normalize_heading("IV."), "Chapter four.");
        assert_eq!(normalize_heading("The Beginning"), "The Beginning.");
    }

    #[test]
    fn masked_footnotes_are_silent() {
        let got = sentences("A claim is made.   Next.");
        assert_eq!(got[0].text, "A claim is made.");
        assert_eq!(got[1].text, "Next.");
    }
}
