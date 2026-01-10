// ===============================
// server.js ✅ FULL CODE (INTACT)
// Feature added in frontend only:
// ✅ If user types Gujarati letters/words → keep exactly as typed (spaces/punctuation/newlines)
// ✅ If user types phonetic English → convert word-by-word (typewriter style)
// ===============================

import express from "express";
import fetch from "node-fetch";
import { Document, Packer, Paragraph, TextRun } from "docx";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 5050;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PAGE_MARK = "[[PAGE_BREAK]]";

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "10mb" }));

app.get("/health", (req, res) => res.status(200).send("ok"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_CHUNK_CHARS = 420;

function cleanLMG(text) {
  return String(text || "")
    .replace(/\u00A0/g, " ")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\r?\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ \,/g, ",")
    .replace(/ \./g, ".")
    .replace(/ \:/g, ":")
    .replace(/ \;/g, ";")
    .trim();
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\u00A0/g, " ");
}

function htmlToDocxParagraphs(html, { fontName, size, defaultBold }) {
  const safe = String(html || "")
    .replace(/\r/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/<div><br><\/div>/gi, "<div>\n</div>")
    .replace(/<br\s*\/?>/gi, "\n");

  const tokens = safe.split(/(<\/?[^>]+>)/g).filter(Boolean);

  let bold = !!defaultBold;
  let italics = false;

  let currentRuns = [];
  const paragraphs = [];

  function pushParagraph() {
    const merged = currentRuns.length
      ? currentRuns
      : [new TextRun({ text: " ", font: fontName, bold, italics, size })];

    paragraphs.push(new Paragraph({ children: merged }));
    currentRuns = [];
  }

  function pushText(t) {
    const txt = String(t || "");
    if (!txt) return;

    const parts = txt.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const piece = parts[i];
      if (piece) {
        currentRuns.push(
          new TextRun({
            text: piece,
            font: fontName,
            bold,
            italics,
            size,
          })
        );
      }
      if (i < parts.length - 1) pushParagraph();
    }
  }

  for (const tok of tokens) {
    const tag = tok.toLowerCase();

    if (tag === "<b>" || tag === "<strong>") {
      bold = true;
      continue;
    }
    if (tag === "</b>" || tag === "</strong>") {
      bold = !!defaultBold;
      continue;
    }
    if (tag === "<i>" || tag === "<em>") {
      italics = true;
      continue;
    }
    if (tag === "</i>" || tag === "</em>") {
      italics = false;
      continue;
    }

    if (tag === "</div>" || tag === "</p>") {
      pushParagraph();
      continue;
    }

    if (tag.startsWith("<")) continue;

    pushText(tok);
  }

  if (currentRuns.length) pushParagraph();

  return paragraphs;
}

async function fetchWithRetry(url, options, retries = 4) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, options);
      if ([429, 502, 503, 504].includes(r.status) && attempt < retries) {
        const backoff = 350 * Math.pow(2, attempt);
        await sleep(backoff);
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        const backoff = 350 * Math.pow(2, attempt);
        await sleep(backoff);
        continue;
      }
      throw lastErr;
    }
  }
}

async function remoteConvert(unicodeText) {
  const url = "https://www.fontconverter.online/gujarati/GetLmgArunText";
  const form = new URLSearchParams();
  form.set("modify_string", unicodeText);

  const r = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept: "text/html,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Origin: "https://www.fontconverter.online",
        Referer: "https://www.fontconverter.online/gujarati",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: form.toString(),
    },
    4
  );

  const body = await r.text().catch(() => "");
  if (!r.ok)
    throw new Error(`REMOTE_BLOCKED_${r.status}: ${body.slice(0, 200)}`);
  return (body || "").replace(/\r?\n$/, "");
}

function splitIntoChunksPreserve(text, maxChars = MAX_CHUNK_CHARS) {
  const t = String(text || "");
  if (!t) return [];
  const chunks = [];
  let i = 0;

  while (i < t.length) {
    let end = Math.min(i + maxChars, t.length);
    let cut = end;

    const window = t.slice(i, end);
    const lastSpace = window.lastIndexOf(" ");
    if (lastSpace > 60) cut = i + lastSpace + 1;

    chunks.push(t.slice(i, cut));
    i = cut;
  }
  return chunks;
}

async function convertParagraphLong(paragraphText) {
  const chunks = splitIntoChunksPreserve(paragraphText, MAX_CHUNK_CHARS);
  let out = "";

  for (let i = 0; i < chunks.length; i++) {
    const safePart = String(chunks[i])
      .replace(/\u00A0/g, " ")
      .trim();
    const converted = await remoteConvert(safePart);
    const c = String(converted || "")
      .replace(/\u00A0/g, " ")
      .trim();

    if (!c) continue;
    if (out && !out.endsWith(" ") && !c.startsWith(" ")) out += " ";
    out += c;

    if (i < chunks.length - 1) await sleep(120);
  }

  return cleanLMG(out);
}

async function convertWithPagesAndParagraphs(rawText) {
  const pages = String(rawText || "").split(PAGE_MARK);
  const convertedPages = [];

  for (const page of pages) {
    const lines = String(page || "").split(/\r?\n/);
    const convertedLines = [];

    for (const line of lines) {
      if (!line.trim()) {
        convertedLines.push("");
        continue;
      }
      const convertedLine = await convertParagraphLong(line);
      convertedLines.push(cleanLMG(convertedLine));
    }

    convertedPages.push(convertedLines.join("\n"));
  }

  return cleanLMG(convertedPages.join("\n\n----- NEW PAGE -----\n\n"));
}

app.post("/convert-lmg", async (req, res) => {
  try {
    const text = String(req.body?.text || "");
    if (!text.trim()) return res.status(400).send("Empty text");
    const converted = await convertWithPagesAndParagraphs(text);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(converted);
  } catch (e) {
    console.error("❌ /convert-lmg error:", e);
    return res.status(500).send(String(e?.message || e || "convert error"));
  }
});

app.post("/download-docx", async (req, res) => {
  try {
    const lmgHtml = String(req.body?.lmgHtml || "");
    const lmgTextFallback = String(req.body?.lmgText || "");
    const weight = String(req.body?.weight || "700");

    // ✅ accept fontName (for dropdown later)
    const FONT_NAME = String(req.body?.fontName || "LMG-Arun");

    const isBoldDefault = Number(weight) >= 700;

    const contentHtml = lmgHtml.trim() ? lmgHtml : lmgTextFallback;
    if (!String(contentHtml || "").trim())
      return res.status(400).send("Empty output");

    const PAGES_SEP = "----- NEW PAGE -----";
    const pages = String(contentHtml).split(PAGES_SEP);

    const children = [];

    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      const pageHtml = String(pages[pageIndex] || "").trim();

      if (pageIndex > 0) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: "" })],
            pageBreakBefore: true,
          })
        );
      }

      const paras = htmlToDocxParagraphs(pageHtml, {
        fontName: FONT_NAME,
        size: 28,
        defaultBold: isBoldDefault,
      });

      if (!paras.length) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: " ",
                font: FONT_NAME,
                bold: isBoldDefault,
                size: 28,
              }),
            ],
          })
        );
      } else {
        children.push(...paras);
      }
    }

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="LMG-Arun-Formatted.docx"'
    );

    return res.send(buffer);
  } catch (e) {
    console.error("❌ /download-docx error:", e);
    return res.status(500).send(String(e?.message || e || "docx error"));
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log("✅ http://localhost:5050");
});
