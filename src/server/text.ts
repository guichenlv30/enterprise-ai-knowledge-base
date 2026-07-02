import fs from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { v4 as uuidv4 } from "uuid";
import { appConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { embedText } from "./vector.js";
import type { DocumentChunk } from "./models.js";

const supportedTypes = new Set([".pdf", ".docx", ".txt", ".md", ".markdown"]);

export function getSupportedFileTypes(): string[] {
  return [...supportedTypes];
}

export function normalizeFileType(fileName: string): string {
  return path.extname(fileName).toLowerCase();
}

export function assertSupportedFile(fileName: string): string {
  const fileType = normalizeFileType(fileName);
  if (!supportedTypes.has(fileType)) {
    throw new HttpError(400, "仅支持 PDF、DOCX、TXT 和 Markdown 文件");
  }
  return fileType.replace(".", "").toUpperCase();
}

export async function parseDocumentText(filePath: string, fileName: string): Promise<string> {
  const extension = normalizeFileType(fileName);
  if (!supportedTypes.has(extension)) {
    throw new HttpError(400, "不支持的文件类型");
  }

  if (extension === ".txt" || extension === ".md" || extension === ".markdown") {
    return fs.readFile(filePath, "utf8");
  }

  if (extension === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  const buffer = await fs.readFile(filePath);
  const result = await pdfParse(buffer);
  return result.text;
}

export function cleanText(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function currentTitle(line: string, previousTitle: string): string {
  const markdownTitle = line.match(/^(#{1,6})\s+(.+)$/);
  if (markdownTitle) return markdownTitle[2].trim();
  const numberedTitle = line.match(/^第[一二三四五六七八九十\d]+[章节条]\s*(.+)$/);
  if (numberedTitle) return numberedTitle[0].trim();
  return previousTitle;
}

function splitLongText(text: string, chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

export function chunkText(params: {
  text: string;
  documentId: number;
  kbId: number;
  chunkSize?: number;
  overlap?: number;
}): DocumentChunk[] {
  const chunkSize = params.chunkSize ?? appConfig.rag.chunkSize;
  const overlap = Math.min(params.overlap ?? appConfig.rag.chunkOverlap, chunkSize - 1);
  const paragraphs = params.text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length >= 8);

  const contents: Array<{ title: string; content: string }> = [];
  let buffer = "";
  let title = "正文";

  for (const paragraph of paragraphs) {
    title = currentTitle(paragraph.split("\n")[0] ?? "", title);
    if (paragraph.length > chunkSize) {
      if (buffer) {
        contents.push({ title, content: buffer.trim() });
        buffer = "";
      }
      for (const piece of splitLongText(paragraph, chunkSize, overlap)) {
        contents.push({ title, content: piece.trim() });
      }
      continue;
    }

    const next = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (next.length > chunkSize && buffer) {
      contents.push({ title, content: buffer.trim() });
      const overlapTail = buffer.slice(Math.max(0, buffer.length - overlap));
      buffer = `${overlapTail}\n\n${paragraph}`.trim();
    } else {
      buffer = next;
    }
  }

  if (buffer.trim()) {
    contents.push({ title, content: buffer.trim() });
  }

  const now = new Date().toISOString();
  return contents.map((item, index) => ({
    id: 0,
    documentId: params.documentId,
    kbId: params.kbId,
    chunkIndex: index,
    title: item.title,
    content: item.content,
    vectorId: `vec_${uuidv4()}`,
    vector: embedText(`${item.title}\n${item.content}`),
    tokenCount: item.content.length,
    createdAt: now
  }));
}
