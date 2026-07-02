import type { DocumentChunk, KnowledgeDocument, RetrievalHit } from "./models.js";

const DIMENSIONS = 384;

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const tokens: string[] = [];
  const words = normalized.match(/[a-z0-9_]+/g) ?? [];
  tokens.push(...words.filter((word) => word.length > 1));

  const cjkChars = [...normalized.matchAll(/\p{Script=Han}/gu)].map((match) => match[0]);
  tokens.push(...cjkChars);
  for (let index = 0; index < cjkChars.length - 1; index += 1) {
    tokens.push(`${cjkChars[index]}${cjkChars[index + 1]}`);
  }

  return tokens;
}

export function embedText(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const token of tokenize(text)) {
    const hash = hashToken(token);
    const slot = hash % DIMENSIONS;
    const sign = hash & 1 ? 1 : -1;
    vector[slot] += sign;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => Number((value / norm).toFixed(6)));
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
  }
  return Number(dot.toFixed(6));
}

function lexicalOverlapScore(question: string, content: string): number {
  const queryTokens = new Set(tokenize(question));
  const contentTokens = new Set(tokenize(content));
  if (queryTokens.size === 0 || contentTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) overlap += 1;
  }
  return overlap / Math.sqrt(queryTokens.size * contentTokens.size);
}

export function retrieveTopK(params: {
  question: string;
  kbId: number;
  chunks: DocumentChunk[];
  documents: KnowledgeDocument[];
  topK: number;
  minScore: number;
}): RetrievalHit[] {
  const queryVector = embedText(params.question);
  return params.chunks
    .filter((chunk) => chunk.kbId === params.kbId)
    .map((chunk) => {
      const vectorScore = cosineSimilarity(queryVector, chunk.vector);
      const lexicalScore = lexicalOverlapScore(params.question, `${chunk.title}\n${chunk.content}`);
      return {
        chunk,
        document: params.documents.find((document) => document.id === chunk.documentId),
        score: Number((vectorScore * 0.78 + lexicalScore * 0.22).toFixed(6))
      };
    })
    .filter((hit) => hit.score >= params.minScore)
    .sort((left, right) => right.score - left.score)
    .slice(0, params.topK);
}
