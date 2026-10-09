import { getEncoding } from 'js-tiktoken';

const CHUNK_SIZE = 256;
const CHUNK_OVERLAP = 50;
const MAX_EMBEDDING_TOKENS = 8192;
const encoder = getEncoding('cl100k_base');

export function countTokens(text: string): number {
  return encoder.encode(text).length;
}

export function isWithinTokenLimit(text: string, limit: number = CHUNK_SIZE): boolean {
  return countTokens(text) <= limit;
}

export function truncateToTokenLimit(text: string, limit: number = MAX_EMBEDDING_TOKENS): string {
  const tokens = encoder.encode(text);
  if (tokens.length <= limit) return text;
  return encoder.decode(tokens.slice(0, limit)) as unknown as string;
}

export type ChunkingStrategy = 'paragraph';

export interface Chunk {
  content: string;
  start: number;
  end: number;
}

interface ChunkOptions {
  maxTokens?: number;
  overlap?: number;
  strategy?: ChunkingStrategy;
}

/**
 * Split text into chunks of ~256 tokens with overlap for better retrieval.
 * Uses paragraph boundaries where possible to keep semantic context together.
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const { maxTokens = CHUNK_SIZE, overlap = CHUNK_OVERLAP, strategy = 'paragraph' } = options;

  if (isWithinTokenLimit(text, maxTokens)) {
    return [{ content: text, start: 0, end: text.length }];
  }

  switch (strategy) {
    case 'paragraph':
      return chunkByParagraphWithOverlap(text, maxTokens, overlap);
    default:
      return chunkByParagraphWithOverlap(text, maxTokens, overlap);
  }
}

/**
 * Chunk text by splitting on paragraph boundaries with overlap.
 * Each chunk targets ~256 tokens, with ~50 token overlap from the previous chunk.
 */
function chunkByParagraphWithOverlap(text: string, maxTokens: number, overlap: number): Chunk[] {
  // First, split into small segments (sentences/words) that we can combine
  const segments = splitIntoSegments(text, maxTokens);
  const chunks: Chunk[] = [];

  let i = 0;
  while (i < segments.length) {
    // Build a chunk starting from segment i
    let chunkContent = segments[i].content;
    const chunkStart = segments[i].start;
    let chunkEnd = segments[i].end;
    let j = i + 1;

    // Add more segments until we hit the token limit
    while (j < segments.length) {
      const nextSegment = segments[j];
      const combined = chunkContent + '\n\n' + nextSegment.content;

      if (countTokens(combined) > maxTokens) {
        break;
      }

      chunkContent = combined;
      chunkEnd = nextSegment.end;
      j++;
    }

    chunks.push({
      content: chunkContent,
      start: chunkStart,
      end: chunkEnd,
    });

    // Move forward, but backtrack for overlap
    // Find how many segments to include in overlap
    if (j >= segments.length) {
      break; // Done, no more segments
    }

    // Calculate overlap: go back from j until we have ~overlap tokens
    let overlapStart = j;
    let overlapTokens = 0;
    while (overlapStart > i && overlapTokens < overlap) {
      overlapStart--;
      overlapTokens += countTokens(segments[overlapStart].content);
    }

    // Start next chunk from overlapStart (but at least move forward by 1)
    i = Math.max(overlapStart, i + 1);
  }

  return chunks;
}

/**
 * Split text into small segments that respect paragraph/sentence boundaries.
 * Each segment is guaranteed to be <= maxTokens.
 */
function splitIntoSegments(
  text: string,
  maxTokens: number,
): Array<{ content: string; start: number; end: number }> {
  const paragraphs = text.split(/\n\n+/);
  const segments: Array<{ content: string; start: number; end: number }> = [];
  let position = 0;

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      position += paragraph.length + 2; // Account for \n\n
      continue;
    }

    const paragraphStart = text.indexOf(paragraph, position);
    const paragraphEnd = paragraphStart + paragraph.length;

    if (countTokens(paragraph) <= maxTokens) {
      segments.push({ content: paragraph, start: paragraphStart, end: paragraphEnd });
    } else {
      // Split large paragraph by sentences
      const sentenceSegments = splitBySentences(paragraph, maxTokens, paragraphStart);
      segments.push(...sentenceSegments);
    }

    position = paragraphEnd;
  }

  return segments;
}

/**
 * Split a paragraph into sentence-based segments.
 */
function splitBySentences(
  text: string,
  maxTokens: number,
  startOffset: number,
): Array<{ content: string; start: number; end: number }> {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const segments: Array<{ content: string; start: number; end: number }> = [];

  let current = '';
  let currentStart = startOffset;
  let position = startOffset;

  for (const sentence of sentences) {
    if (!current) {
      currentStart = position;
    }

    const combined = current ? current + ' ' + sentence : sentence;

    if (countTokens(combined) <= maxTokens) {
      current = combined;
    } else {
      // Save current if we have something
      if (current) {
        segments.push({
          content: current,
          start: currentStart,
          end: currentStart + current.length,
        });
      }

      // Handle sentence that's too long on its own
      if (countTokens(sentence) > maxTokens) {
        const wordSegments = splitByWords(sentence, maxTokens, position);
        segments.push(...wordSegments);
        current = '';
        currentStart = position + sentence.length;
      } else {
        current = sentence;
        currentStart = position;
      }
    }

    position += sentence.length + 1; // +1 for space
  }

  if (current) {
    segments.push({
      content: current,
      start: currentStart,
      end: currentStart + current.length,
    });
  }

  return segments;
}

/**
 * Last resort: split by words.
 */
function splitByWords(
  text: string,
  maxTokens: number,
  startOffset: number,
): Array<{ content: string; start: number; end: number }> {
  const words = text.split(/\s+/);
  const segments: Array<{ content: string; start: number; end: number }> = [];

  let current = '';
  let currentStart = startOffset;

  for (const word of words) {
    const combined = current ? current + ' ' + word : word;

    if (countTokens(combined) <= maxTokens) {
      current = combined;
    } else {
      if (current) {
        segments.push({
          content: current,
          start: currentStart,
          end: currentStart + current.length,
        });
        currentStart += current.length + 1;
      }
      current = word;
    }
  }

  if (current) {
    segments.push({
      content: current,
      start: currentStart,
      end: currentStart + current.length,
    });
  }

  return segments;
}

export { CHUNK_SIZE, CHUNK_OVERLAP, MAX_EMBEDDING_TOKENS };
