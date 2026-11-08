//! Turns untrusted (X)HTML into Kōyō's block model. Output is built only from an
//! allowlist, so this walker doubles as the sanitizer: scripts, styles, event handlers
//! and remote resources never reach the page.
//!
//! Each block's stored `text` equals the DOM `textContent` of its element, which is what
//! lets highlights, AI citations and read-along share a single set of character offsets.

use regex::Regex;
use scraper::{ElementRef, Html, Node};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use super::RawBlock;

#[derive(Default, Clone)]
pub struct CssHints {
    italic: HashSet<String>,
    bold: HashSet<String>,
    center: HashSet<String>,
    right: HashSet<String>,
    indent: HashSet<String>,
    sup: HashSet<String>,
    hidden: HashSet<String>,
}

static CSS_COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)/\*.*?\*/").unwrap());
static CSS_RULE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)([^{}]+)\{([^{}]*)\}").unwrap());
static CSS_CLASS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:[a-zA-Z][a-zA-Z0-9]*)?\.([A-Za-z0-9_-]+)$").unwrap());
static SELF_CLOSED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<([a-zA-Z][a-zA-Z0-9:_-]*)((?:\s[^<>]*?)?)/>").unwrap());

impl CssHints {
    /// EPUBs often express emphasis and layout only through classes. Author CSS is not
    /// safe to apply to the app, so the few properties that carry meaning become markup.
    pub fn absorb(&mut self, css: &str) {
        let css = CSS_COMMENT.replace_all(css, " ");
        for rule in CSS_RULE.captures_iter(&css) {
            let body = rule[2].to_ascii_lowercase().replace(char::is_whitespace, "");
            for selector in rule[1].split(',') {
                let Some(class) = CSS_CLASS.captures(selector.trim()) else { continue };
                let class = class[1].to_string();
                let has = |needle: &str| body.contains(needle);
                if has("font-style:italic") || has("font-style:oblique") {
                    self.italic.insert(class.clone());
                }
                if has("font-weight:bold") || has("font-weight:700") || has("font-weight:800") || has("font-weight:900") {
                    self.bold.insert(class.clone());
                }
                if has("text-align:center") {
                    self.center.insert(class.clone());
                }
                if has("text-align:right") {
                    self.right.insert(class.clone());
                }
                if has("vertical-align:super") {
                    self.sup.insert(class.clone());
                }
                if has("display:none") || has("visibility:hidden") {
                    self.hidden.insert(class.clone());
                }
                if body.contains("margin-left:") && !has("margin-left:0") && !has("margin-left:auto") {
                    self.indent.insert(class);
                }
            }
        }
    }
}

const SKIP: &[&str] = &[
    "head", "title", "script", "style", "meta", "link", "template", "iframe", "object", "embed", "noscript", "audio",
    "video", "source", "track", "form", "input", "button", "select", "textarea", "canvas", "map", "area", "applet",
    "base", "frame", "frameset", "rp", "rt",
];
const INLINE: &[&str] = &[
    "a", "abbr", "acronym", "b", "bdi", "bdo", "big", "br", "cite", "code", "data", "del", "dfn", "em", "font", "i",
    "image", "img", "ins", "kbd", "label", "mark", "nobr", "q", "rb", "ruby", "s", "samp", "small", "span", "strike",
    "strong", "sub", "sup", "svg", "time", "tt", "u", "var", "wbr",
];
const LEAF: &[&str] = &["p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "dt", "dd", "li", "td", "th", "figcaption", "caption"];
const KEEP: &[&str] = &[
    "blockquote", "ul", "ol", "dl", "table", "thead", "tbody", "tfoot", "tr", "figure", "li", "td", "th", "dd", "dt",
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "pre", "figcaption", "caption",
];
const NO_SPEECH_CLASSES: &[&str] = &["pagenum", "pageno", "page-number", "pagenumber", "page_number", "pb"];

pub struct WalkContext<'a> {
    pub hints: &'a CssHints,
    /// Maps a document-relative image reference to a served URL.
    pub image: &'a mut dyn FnMut(&str) -> Option<String>,
    /// Maps a document-relative link to an output href.
    pub link: &'a mut dyn FnMut(&str) -> Option<String>,
}

pub struct WalkOutput {
    pub html: String,
    pub blocks: Vec<RawBlock>,
    /// Element id to the block it lands on.
    pub anchors: HashMap<String, u32>,
    pub lang: Option<String>,
}

struct Walker<'a, 'b> {
    cx: &'a mut WalkContext<'b>,
    out: String,
    blocks: Vec<RawBlock>,
    anchors: HashMap<String, u32>,
    pending_ids: Vec<String>,
    next_seq: u32,
    quote: usize,
    aside: usize,
}

struct Inline {
    html: String,
    text: String,
    /// Same UTF-16 length as `text`, with footnote markers blanked, for TTS.
    speech: String,
    pending_space: bool,
    pre: bool,
    images: usize,
    muted: usize,
}

impl Inline {
    fn new(pre: bool) -> Self {
        Inline { html: String::new(), text: String::new(), speech: String::new(), pending_space: false, pre, images: 0, muted: 0 }
    }

    fn push_raw(&mut self, s: &str) {
        escape_into(&mut self.html, s);
        self.text.push_str(s);
        if self.muted > 0 {
            for unit in s.chars() {
                for _ in 0..unit.len_utf16() {
                    self.speech.push(' ');
                }
            }
        } else {
            self.speech.push_str(s);
        }
    }

    fn flush_space(&mut self) {
        if self.pending_space {
            self.pending_space = false;
            if !self.text.is_empty() && !self.text.ends_with(' ') {
                self.push_raw(" ");
            }
        }
    }

    fn text(&mut self, s: &str) {
        if self.pre {
            self.push_raw(s);
            return;
        }
        let mut word = String::new();
        for c in s.chars() {
            if is_collapsible(c) {
                if !word.is_empty() {
                    self.flush_space();
                    self.push_raw(&word);
                    word.clear();
                }
                self.pending_space = true;
            } else {
                word.push(c);
            }
        }
        if !word.is_empty() {
            self.flush_space();
            self.push_raw(&word);
        }
    }

    /// A `<br>` is invisible to `textContent`, so an explicit space keeps "line one" and
    /// "line two" apart in search, prompts and speech without shifting offsets.
    fn line_break(&mut self) {
        self.pending_space = false;
        if !self.text.is_empty() && !self.text.ends_with(' ') {
            self.push_raw(" ");
        }
        self.html.push_str("<br>");
    }
}

fn is_collapsible(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{0c}' | '\u{a0}')
}

pub fn escape_into(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
}

pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    escape_into(&mut out, s);
    out
}

fn classes<'e>(el: &'e ElementRef) -> impl Iterator<Item = &'e str> {
    el.value().attr("class").unwrap_or("").split_whitespace()
}

fn name_of(el: &ElementRef) -> String {
    el.value().name().rsplit(':').next().unwrap_or("").to_ascii_lowercase()
}

fn style_has(el: &ElementRef, needle: &str) -> bool {
    el.value().attr("style").is_some_and(|s| s.to_ascii_lowercase().replace(char::is_whitespace, "").contains(needle))
}

impl<'a, 'b> Walker<'a, 'b> {
    fn hidden(&self, el: &ElementRef) -> bool {
        if el.value().attr("hidden").is_some() || style_has(el, "display:none") {
            return true;
        }
        if classes(el).any(|c| self.cx.hints.hidden.contains(c) || c.starts_with("pg-boilerplate") || c.starts_with("pgheader") || c == "pgfooter") {
            return true;
        }
        if el.value().attr("id").is_some_and(|id| id.starts_with("pg-header") || id.starts_with("pg-footer")) {
            return true;
        }
        let epub_type = el.value().attr("epub:type").unwrap_or("");
        let role = el.value().attr("role").unwrap_or("");
        epub_type.contains("pagebreak") || role == "doc-pagebreak" || classes(el).any(|c| NO_SPEECH_CLASSES.contains(&c))
    }

    fn is_inline_node(&self, node: ego_tree::NodeRef<'_, Node>) -> bool {
        match node.value() {
            Node::Text(_) => true,
            Node::Element(_) => {
                let el = ElementRef::wrap(node).unwrap();
                let name = name_of(&el);
                if SKIP.contains(&name.as_str()) || self.hidden(&el) {
                    return true;
                }
                INLINE.contains(&name.as_str()) && node.children().all(|c| self.is_inline_node(c))
            }
            _ => true,
        }
    }

    fn note_id(&mut self, el: &ElementRef) {
        for attr in ["id", "name"] {
            if let Some(id) = el.value().attr(attr) {
                self.pending_ids.push(id.to_string());
            }
        }
    }

    fn assign_pending(&mut self, seq: u32) {
        for id in self.pending_ids.drain(..) {
            self.anchors.entry(id).or_insert(seq);
        }
    }

    fn inline_node(&mut self, node: ego_tree::NodeRef<'_, Node>, buf: &mut Inline) {
        match node.value() {
            Node::Text(t) => buf.text(t),
            Node::Element(_) => {
                let el = ElementRef::wrap(node).unwrap();
                let name = name_of(&el);
                if SKIP.contains(&name.as_str()) || self.hidden(&el) {
                    return;
                }
                self.note_id(&el);
                match name.as_str() {
                    "br" => buf.line_break(),
                    "wbr" => {}
                    "img" | "image" => {
                        let src = el.value().attr("src").or(el.value().attr("href")).or(el.value().attr("xlink:href"));
                        self.image(src, el.value().attr("alt"), buf);
                    }
                    "svg" => {
                        for child in node.descendants() {
                            if let Some(image) = ElementRef::wrap(child) {
                                if name_of(&image) == "image" {
                                    let src = image.value().attr("xlink:href").or(image.value().attr("href"));
                                    self.image(src, None, buf);
                                    return;
                                }
                            }
                        }
                    }
                    "a" => self.inline_link(node, &el, buf),
                    _ => {
                        let mut wrappers: Vec<&str> = Vec::new();
                        let classes_match = |set: &HashSet<String>| classes(&el).any(|c| set.contains(c));
                        match name.as_str() {
                            "em" | "i" | "cite" | "dfn" | "var" => wrappers.push("em"),
                            "strong" | "b" => wrappers.push("strong"),
                            "u" | "ins" => wrappers.push("u"),
                            "s" | "strike" | "del" => wrappers.push("s"),
                            "sub" => wrappers.push("sub"),
                            "sup" => wrappers.push("sup"),
                            "small" => wrappers.push("small"),
                            "code" | "kbd" | "samp" | "tt" => wrappers.push("code"),
                            _ => {}
                        }
                        if classes_match(&self.cx.hints.italic) && !wrappers.contains(&"em") {
                            wrappers.push("em");
                        }
                        if classes_match(&self.cx.hints.bold) && !wrappers.contains(&"strong") {
                            wrappers.push("strong");
                        }
                        if classes_match(&self.cx.hints.sup) && !wrappers.contains(&"sup") {
                            wrappers.push("sup");
                        }
                        let open = |buf: &mut Inline, w: &str| {
                            buf.flush_space();
                            buf.html.push('<');
                            buf.html.push_str(w);
                            buf.html.push('>');
                        };
                        for w in &wrappers {
                            open(buf, w);
                        }
                        for child in node.children() {
                            self.inline_node(child, buf);
                        }
                        for w in wrappers.iter().rev() {
                            buf.html.push_str("</");
                            buf.html.push_str(w);
                            buf.html.push('>');
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn inline_link(&mut self, node: ego_tree::NodeRef<'_, Node>, el: &ElementRef, buf: &mut Inline) {
        let href = el.value().attr("href").and_then(|h| (self.cx.link)(h));
        let noteref = el.value().attr("epub:type").is_some_and(|t| t.contains("noteref"))
            || el.value().attr("role") == Some("doc-noteref")
            || (href.is_some() && link_text_is_marker(node));
        if noteref {
            buf.muted += 1;
        }
        match href {
            Some(href) => {
                buf.flush_space();
                buf.html.push_str("<a href=\"");
                escape_into(&mut buf.html, &href);
                buf.html.push_str("\">");
                for child in node.children() {
                    self.inline_node(child, buf);
                }
                buf.html.push_str("</a>");
            }
            None => {
                for child in node.children() {
                    self.inline_node(child, buf);
                }
            }
        }
        if noteref {
            buf.muted -= 1;
        }
    }

    fn image(&mut self, src: Option<&str>, alt: Option<&str>, buf: &mut Inline) {
        let Some(url) = src.and_then(|s| (self.cx.image)(s)) else { return };
        buf.flush_space();
        buf.images += 1;
        buf.html.push_str("<img loading=\"lazy\" src=\"");
        escape_into(&mut buf.html, &url);
        buf.html.push_str("\" alt=\"");
        escape_into(&mut buf.html, alt.unwrap_or(""));
        buf.html.push_str("\">");
    }

    fn flush(&mut self, run: &mut Vec<ego_tree::NodeRef<'_, Node>>, tag: &str, attrs: &str) {
        if run.is_empty() {
            if matches!(tag, "td" | "th") {
                self.out.push_str(&format!("<{tag}></{tag}>"));
            }
            return;
        }
        let mut buf = Inline::new(tag == "pre");
        for node in run.drain(..) {
            self.inline_node(node, &mut buf);
        }
        if buf.pre {
            while buf.text.ends_with('\n') {
                buf.text.pop();
                buf.speech.pop();
                while buf.html.ends_with('\n') {
                    buf.html.pop();
                }
            }
        }
        if buf.text.trim().is_empty() {
            if buf.images > 0 {
                self.out.push_str("<p class=\"img\">");
                self.out.push_str(&buf.html);
                self.out.push_str("</p>");
            } else if matches!(tag, "td" | "th") {
                self.out.push_str(&format!("<{tag}></{tag}>"));
            }
            return;
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        self.assign_pending(seq);
        let kind = match tag {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => tag,
            "pre" => "code",
            "td" | "th" => "cell",
            "li" | "dd" | "dt" => "li",
            "figcaption" | "caption" => "cap",
            _ if self.aside > 0 => "note",
            _ if self.quote > 0 => "quote",
            _ => "p",
        };
        self.out.push_str(&format!("<{tag} data-b=\"{seq}\"{attrs}>"));
        self.out.push_str(&buf.html);
        self.out.push_str(&format!("</{tag}>"));
        let speech = (buf.speech != buf.text).then_some(buf.speech);
        self.blocks.push(RawBlock { seq, kind: kind.to_string(), text: buf.text, speech, ..Default::default() });
    }

    fn layout_attrs(&self, el: &ElementRef) -> String {
        let hits = |set: &HashSet<String>| classes(el).any(|c| set.contains(c));
        let mut attrs = String::new();
        if hits(&self.cx.hints.center) || style_has(el, "text-align:center") || el.value().attr("align") == Some("center") {
            attrs.push_str(" data-a=\"c\"");
        } else if hits(&self.cx.hints.right) || style_has(el, "text-align:right") || el.value().attr("align") == Some("right") {
            attrs.push_str(" data-a=\"r\"");
        }
        if hits(&self.cx.hints.indent) {
            attrs.push_str(" data-i=\"1\"");
        }
        attrs
    }

    fn children(&mut self, node: ego_tree::NodeRef<'_, Node>, attrs: &str) {
        let mut run = Vec::new();
        for child in node.children() {
            if matches!(child.value(), Node::Comment(_) | Node::ProcessingInstruction(_) | Node::Doctype(_)) {
                continue;
            }
            if self.is_inline_node(child) {
                run.push(child);
            } else {
                self.flush(&mut run, "p", attrs);
                self.block(child);
            }
        }
        self.flush(&mut run, "p", attrs);
    }

    fn block(&mut self, node: ego_tree::NodeRef<'_, Node>) {
        let Some(el) = ElementRef::wrap(node) else { return };
        let name = name_of(&el);
        if SKIP.contains(&name.as_str()) || self.hidden(&el) {
            return;
        }
        self.note_id(&el);
        let attrs = self.layout_attrs(&el);
        if name == "hr" {
            self.out.push_str("<hr>");
            return;
        }
        let tag: &str = name.as_str();
        let all_inline = node.children().all(|c| self.is_inline_node(c));
        if LEAF.contains(&tag) && all_inline {
            let mut run: Vec<_> = node.children().collect();
            self.flush(&mut run, tag, &attrs);
            return;
        }
        let is_quote = tag == "blockquote";
        let is_aside = tag == "aside";
        self.quote += is_quote as usize;
        self.aside += is_aside as usize;
        let keep = KEEP.contains(&tag);
        if keep {
            self.out.push_str(&format!("<{tag}{attrs}>"));
        }
        let child_attrs = if keep { String::new() } else { attrs };
        self.children(node, &child_attrs);
        if keep {
            self.out.push_str(&format!("</{tag}>"));
        }
        self.quote -= is_quote as usize;
        self.aside -= is_aside as usize;
    }
}

/// True for link text like `1`, `[12]`, `*` or `†`, the shape of a footnote reference.
fn link_text_is_marker(node: ego_tree::NodeRef<'_, Node>) -> bool {
    let mut text = String::new();
    for d in node.descendants() {
        if let Node::Text(t) = d.value() {
            text.push_str(t);
        }
    }
    let t = text.trim().trim_matches(['[', ']', '(', ')']);
    !t.is_empty() && t.len() <= 4 && t.chars().all(|c| c.is_ascii_digit() || "*†‡§".contains(c))
}

/// The HTML5 parser treats `<title/>` or `<a id="x"/>` as an open tag, which can swallow
/// a whole XHTML chapter. Expanding non-void self-closed tags keeps XHTML semantics.
pub fn expand_self_closed(xhtml: &str) -> String {
    const VOID: &[&str] = &["br", "hr", "img", "meta", "link", "input", "col", "area", "base", "embed", "source", "track", "wbr", "image"];
    SELF_CLOSED
        .replace_all(xhtml, |c: &regex::Captures| {
            let tag = &c[1];
            if VOID.contains(&tag.to_ascii_lowercase().as_str()) {
                c[0].to_string()
            } else {
                format!("<{tag}{}></{tag}>", &c[2])
            }
        })
        .into_owned()
}

pub fn walk(source: &str, first_seq: u32, cx: &mut WalkContext) -> WalkOutput {
    let doc = Html::parse_document(&expand_self_closed(source));
    let root = doc.root_element();
    let lang = root.value().attr("lang").or(root.value().attr("xml:lang")).map(str::to_string);
    let mut walker = Walker {
        cx,
        out: String::new(),
        blocks: Vec::new(),
        anchors: HashMap::new(),
        pending_ids: Vec::new(),
        next_seq: first_seq,
        quote: 0,
        aside: 0,
    };
    for child in root.children() {
        if let Some(el) = ElementRef::wrap(child) {
            if name_of(&el) == "body" {
                walker.note_id(&el);
                walker.children(child, "");
            }
        }
    }
    let last = walker.next_seq.saturating_sub(1).max(first_seq);
    walker.assign_pending(last);
    WalkOutput { html: walker.out, blocks: walker.blocks, anchors: walker.anchors, lang }
}

pub fn strip_tags(html: &str) -> String {
    let doc = Html::parse_fragment(html);
    let text: String = doc.root_element().text().collect::<Vec<_>>().join(" ");
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
