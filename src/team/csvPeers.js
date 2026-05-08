const HEADER = ['name', 'host', 'port'];
const BOM = '﻿';

function parse(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  const entries = [];
  const errors = [];
  const seenNames = new Set();
  let headerSeen = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;

    const cols = line.split(',').map((c) => c.trim());

    if (!headerSeen) {
      if (cols.length !== 3 || cols[0] !== HEADER[0] || cols[1] !== HEADER[1] || cols[2] !== HEADER[2]) {
        errors.push({ line: i + 1, message: '헤더는 정확히 "name,host,port" 여야 합니다' });
        return { entries: [], errors };
      }
      headerSeen = true;
      continue;
    }

    if (cols.length !== 3) {
      errors.push({ line: i + 1, message: `열 개수가 3개가 아님 (현재 ${cols.length}개)` });
      continue;
    }

    const [name, host, portStr] = cols;
    if (!name) { errors.push({ line: i + 1, message: 'name이 비어 있음' }); continue; }
    if (!host) { errors.push({ line: i + 1, message: 'host가 비어 있음' }); continue; }
    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push({ line: i + 1, message: `port가 유효하지 않음: "${portStr}"` });
      continue;
    }
    if (seenNames.has(name)) {
      errors.push({ line: i + 1, message: `중복된 name: "${name}"` });
      continue;
    }
    seenNames.add(name);
    entries.push({ name, host, port });
  }

  if (!headerSeen) {
    errors.push({ line: 0, message: '헤더 행이 없습니다' });
  }

  return { entries, errors };
}

function serialize(entries) {
  const lines = [HEADER.join(',')];
  for (const e of entries) {
    lines.push(`${e.name},${e.host},${e.port}`);
  }
  return BOM + lines.join('\n') + '\n';
}

module.exports = { parse, serialize, HEADER };
