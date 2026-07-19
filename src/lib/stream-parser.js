// Incremental JSON backup parser: feed arbitrary text chunks, receive one
// callback per array item. Never holds the whole document in memory, so a
// 100MB backup restores within Workers' isolate memory limits.
const SEARCH_BUFFER_TAIL = 128;
const ROOT_ARRAY_RE = /^\s*\[/;
const ROOT_OBJECT_RE = /^\s*\{/;
const ENTRIES_ARRAY_RE = /"(?:diaries|notes|entries|list)"\s*:\s*\[/;

export function createStreamingBackupParser({ onEntry }) {
  let mode = 'detectRoot', rootType = '', searchBuffer = '';
  let itemBuffer = '', itemDepth = 0, itemStarted = false, inString = false, escapeNext = false;
  let sawEntryArray = false;

  const resetItemState = () => {
    itemBuffer = ''; itemDepth = 0; itemStarted = false; inString = false; escapeNext = false;
  };

  const activateArray = () => {
    mode = 'array';
    sawEntryArray = true;
  };

  const emitCurrentItem = async () => {
    const raw = itemBuffer.trim();
    resetItemState();
    if (!raw) return;
    await onEntry(JSON.parse(raw));
  };

  const closeCurrentArray = () => {
    resetItemState();
    mode = 'done';
  };

  const processArrayChar = async (char) => {
    if (!itemStarted) {
      if (/\s/.test(char) || char === ',') return;
      if (char === ']') return closeCurrentArray();

      itemStarted = true;
      itemBuffer = char;
      itemDepth = char === '{' || char === '[' ? 1 : 0;
      inString = char === '"';
      escapeNext = false;

      if (itemDepth === 0 && !inString) await emitCurrentItem();
      return;
    }

    itemBuffer += char;

    if (inString) {
      if (escapeNext) escapeNext = false;
      else if (char === '\\') escapeNext = true;
      else if (char === '"') inString = false;
      return;
    }

    if (char === '"') inString = true;
    else if (char === '{' || char === '[') itemDepth += 1;
    else if (char === '}' || char === ']') {
      itemDepth -= 1;
      if (itemDepth === 0) await emitCurrentItem();
    }
  };

  const keepSearchTail = () => { searchBuffer = searchBuffer.slice(-SEARCH_BUFFER_TAIL); };

  const detectRoot = () => {
    searchBuffer = searchBuffer.replace(/^﻿/, '');
    const arrayMatch = searchBuffer.match(ROOT_ARRAY_RE);
    if (arrayMatch) {
      rootType = 'array';
      const remainder = searchBuffer.slice((arrayMatch.index ?? 0) + arrayMatch[0].length);
      searchBuffer = '';
      activateArray();
      return remainder;
    }

    const objectMatch = searchBuffer.match(ROOT_OBJECT_RE);
    if (objectMatch) {
      rootType = 'object';
      const remainder = searchBuffer.slice((objectMatch.index ?? 0) + objectMatch[0].length);
      searchBuffer = '';
      mode = 'seekArray';
      return remainder;
    }

    if (/\S/.test(searchBuffer)) throw new Error('Invalid backup format');
    keepSearchTail();
    return null;
  };

  const searchForEntryArray = () => {
    const match = searchBuffer.match(ENTRIES_ARRAY_RE);
    if (!match) { keepSearchTail(); return null; }
    const remainder = searchBuffer.slice((match.index ?? 0) + match[0].length);
    searchBuffer = '';
    activateArray();
    return remainder;
  };

  return {
    async push(text) {
      let remaining = text;
      while (remaining) {
        if (mode === 'done') return;

        if (mode === 'detectRoot') {
          searchBuffer += remaining;
          const next = detectRoot();
          if (next == null) return;
          remaining = next;
          continue;
        }

        if (mode === 'seekArray') {
          searchBuffer += remaining;
          const next = searchForEntryArray();
          if (next == null) return;
          remaining = next;
          continue;
        }

        for (let i = 0; i < remaining.length; i += 1) {
          await processArrayChar(remaining[i]);
          if (mode !== 'array') {
            remaining = remaining.slice(i + 1);
            break;
          }
          if (i === remaining.length - 1) remaining = '';
        }
      }
    },
    async finish() {
      if (!rootType || mode === 'detectRoot' || mode === 'array' || itemStarted || inString || itemDepth !== 0) {
        throw new Error('Invalid backup format');
      }
      if (!sawEntryArray) throw new Error('Invalid data format');
    }
  };
}
