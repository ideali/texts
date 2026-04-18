/**
 * Compact phoneme search trie using flat typed arrays.
 *
 * Building phase uses TrieNode (linked Map-based tree), then
 * compactify() flattens it via BFS into a CompactTrie with
 * contiguous arrays for cache-friendly traversal.
 */

// ── Verse end metadata stored at trie leaves ────────────────────────

export interface VerseEnd {
  verseIndex: number;
  spanLength: number;
}

// ── Temporary node for building ─────────────────────────────────────

interface TrieNode {
  children: Map<number, TrieNode>;
  verseEnds: VerseEnd[];
  compactIdx: number;
}

function createTrieNode(): TrieNode {
  return { children: new Map(), verseEnds: [], compactIdx: -1 };
}

function insertIntoTrie(root: TrieNode, tokenIds: number[], verseEnd: VerseEnd): void {
  let node = root;
  for (const id of tokenIds) {
    let child = node.children.get(id);
    if (!child) {
      child = createTrieNode();
      node.children.set(id, child);
    }
    node = child;
  }
  node.verseEnds.push(verseEnd);
}

// ── CompactTrie: flat array representation ──────────────────────────

export class CompactTrie {
  /** Per-node: starting index in edge arrays. */
  readonly edgeStart: Uint32Array;
  /** Per-node: number of outgoing edges. */
  readonly edgeCount: Uint8Array;
  /** Flat edge tokens (sorted ascending per node). */
  readonly edgeToken: Uint8Array;
  /** Flat edge child node indices. */
  readonly edgeChild: Int32Array;
  /** Per-node: verse ends (if any). */
  readonly verseEnds: VerseEnd[][];
  /** Total number of nodes. */
  readonly nodeCount: number;

  constructor(
    edgeStart: Uint32Array,
    edgeCount: Uint8Array,
    edgeToken: Uint8Array,
    edgeChild: Int32Array,
    verseEnds: VerseEnd[][],
    nodeCount: number,
  ) {
    this.edgeStart = edgeStart;
    this.edgeCount = edgeCount;
    this.edgeToken = edgeToken;
    this.edgeChild = edgeChild;
    this.verseEnds = verseEnds;
    this.nodeCount = nodeCount;
  }

  /** Find child node by token id. Returns -1 if not found. Edges are sorted, so early exit on overshoot. */
  getChild(nodeIdx: number, tokenId: number): number {
    const start = this.edgeStart[nodeIdx];
    const count = this.edgeCount[nodeIdx];
    for (let i = 0; i < count; i++) {
      const tok = this.edgeToken[start + i];
      if (tok === tokenId) return this.edgeChild[start + i];
      if (tok > tokenId) return -1;
    }
    return -1;
  }

  /** Walk a sequence of token ids from a starting node. Returns final node or -1 if path breaks. */
  walk(startNode: number, tokenIds: number[]): number {
    let node = startNode;
    for (const id of tokenIds) {
      node = this.getChild(node, id);
      if (node === -1) return -1;
    }
    return node;
  }

  /** Return all valid child token ids for a node. */
  validChildren(nodeIdx: number): number[] {
    const start = this.edgeStart[nodeIdx];
    const count = this.edgeCount[nodeIdx];
    const result = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      result[i] = this.edgeToken[start + i];
    }
    return result;
  }

  /** Iterate over children of a node. */
  forEachChild(nodeIdx: number, callback: (tokenId: number, childIdx: number) => void): void {
    const start = this.edgeStart[nodeIdx];
    const count = this.edgeCount[nodeIdx];
    for (let i = 0; i < count; i++) {
      callback(this.edgeToken[start + i], this.edgeChild[start + i]);
    }
  }

  /** Collect all verse ends reachable from a node (DFS). */
  collectVerseEnds(nodeIdx: number): VerseEnd[] {
    const results: VerseEnd[] = [];
    const stack = [nodeIdx];

    while (stack.length > 0) {
      const idx = stack.pop()!;
      for (const ve of this.verseEnds[idx]) results.push(ve);

      const start = this.edgeStart[idx];
      const count = this.edgeCount[idx];
      for (let i = 0; i < count; i++) {
        stack.push(this.edgeChild[start + i]);
      }
    }

    return results;
  }

  /** Estimate memory usage of typed arrays in bytes. */
  estimateMemoryBytes(): number {
    return (
      this.edgeStart.byteLength +
      this.edgeCount.byteLength +
      this.edgeToken.byteLength +
      this.edgeChild.byteLength
    );
  }
}

// ── BFS compaction ──────────────────────────────────────────────────

/** Flatten a TrieNode tree into a CompactTrie via BFS. */
export function compactify(root: TrieNode): CompactTrie {
  let nodeCount = 0;
  let totalEdges = 0;

  // BFS to assign indices and count edges
  const queue: TrieNode[] = [root];
  const ordered: TrieNode[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    node.compactIdx = nodeCount++;
    ordered.push(node);
    totalEdges += node.children.size;

    const sortedKeys = [...node.children.keys()].sort((a, b) => a - b);
    for (const key of sortedKeys) {
      queue.push(node.children.get(key)!);
    }
  }

  // Allocate flat arrays
  const edgeStart = new Uint32Array(nodeCount);
  const edgeCount = new Uint8Array(nodeCount);
  const edgeToken = new Uint8Array(totalEdges);
  const edgeChild = new Int32Array(totalEdges);
  const verseEnds: VerseEnd[][] = new Array(nodeCount);

  let edgePos = 0;
  for (const node of ordered) {
    const idx = node.compactIdx;
    edgeStart[idx] = edgePos;

    const sortedKeys = [...node.children.keys()].sort((a, b) => a - b);
    edgeCount[idx] = sortedKeys.length;
    verseEnds[idx] = node.verseEnds;

    for (const key of sortedKeys) {
      edgeToken[edgePos] = key;
      edgeChild[edgePos] = node.children.get(key)!.compactIdx;
      edgePos++;
    }
  }

  return new CompactTrie(edgeStart, edgeCount, edgeToken, edgeChild, verseEnds, nodeCount);
}

// ── Build trie from verse data ──────────────────────────────────────

interface TrieBuildStats {
  nodeCount: number;
  totalEdges: number;
  singleVerseCount: number;
  spanCount: number;
  maxDepth: number;
  memoryMB: number;
}

/**
 * Build a phoneme search trie from verses.
 * Inserts single-verse sequences and multi-verse spans (up to maxSpanLength)
 * within the same surah. Spans are joined with the "|" token.
 */
export function buildPhonemeSearchTrie(
  verses: { phonemes: string; surah: number }[],
  vocab: Record<string, string>,
  maxSpanLength: number = 3,
): { trie: CompactTrie; stats: TrieBuildStats } {
  // Build token-to-id map (excluding <blank>)
  const tokenToId = new Map<string, number>();
  for (const [idStr, token] of Object.entries(vocab)) {
    if (token !== '<blank>') {
      tokenToId.set(token, parseInt(idStr));
    }
  }

  const root = createTrieNode();

  // Encode each verse's phonemes to token ids
  const encoded = verses.map((v) => encodePhonemes(v.phonemes, tokenToId));

  let singleCount = 0;
  let spanCount = 0;
  let maxDepth = 0;

  // Insert single verses
  for (let i = 0; i < verses.length; i++) {
    const ids = encoded[i];
    if (ids.length > 0) {
      insertIntoTrie(root, ids, { verseIndex: i, spanLength: 1 });
      singleCount++;
      if (ids.length > maxDepth) maxDepth = ids.length;
    }
  }

  // Insert multi-verse spans
  const pipeId = tokenToId.get('|');
  for (let spanLen = 2; spanLen <= maxSpanLength; spanLen++) {
    for (let start = 0; start + spanLen - 1 < verses.length; start++) {
      // Only span within same surah
      if (verses[start].surah !== verses[start + spanLen - 1].surah) continue;

      const combined: number[] = [];
      let valid = true;

      for (let j = 0; j < spanLen; j++) {
        const ids = encoded[start + j];
        if (ids.length === 0) { valid = false; break; }
        if (j > 0 && pipeId !== undefined) combined.push(pipeId);
        for (const id of ids) combined.push(id);
      }

      if (valid && combined.length > 0) {
        insertIntoTrie(root, combined, { verseIndex: start, spanLength: spanLen });
        spanCount++;
        if (combined.length > maxDepth) maxDepth = combined.length;
      }
    }
  }

  const trie = compactify(root);
  const memBytes = trie.estimateMemoryBytes();

  return {
    trie,
    stats: {
      nodeCount: trie.nodeCount,
      totalEdges: trie.edgeToken.length,
      singleVerseCount: singleCount,
      spanCount,
      maxDepth,
      memoryMB: memBytes / (1024 * 1024),
    },
  };
}

function encodePhonemes(phonemes: string, tokenToId: Map<string, number>): number[] {
  const ids: number[] = [];
  for (const token of phonemes.trim().split(/\s+/)) {
    if (!token) continue;
    const id = tokenToId.get(token);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/** Alias used by worker/inference.ts. */
export const buildPhonemeTrie = buildPhonemeSearchTrie;
