import { Fragment, useMemo, type ReactNode } from 'react';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';

type TableAlign = 'left' | 'center' | 'right';

type ListItem = {
  text: string;
  checked?: boolean;
};

type Block =
  | { type: 'code'; lang: string; code: string }
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { type: 'hr' }
  | { type: 'table'; headers: string[]; alignments: TableAlign[]; rows: string[][] }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | { type: 'quote'; lines: string[] }
  | { type: 'paragraph'; text: string };

const TABLE_SEPARATOR_RE = /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/;

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i++;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseTableAlignments(line: string, count: number): TableAlign[] {
  const parts = splitTableRow(line);
  return Array.from({ length: count }, (_, idx) => {
    const token = (parts[idx] ?? '').trim();
    const left = token.startsWith(':');
    const right = token.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

function isTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false;
  return lines[index].includes('|') && TABLE_SEPARATOR_RE.test(lines[index + 1]);
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(/^(\s*)```([\w-]*)\s*$/);
    if (fence) {
      const indent = fence[1] || '';
      const lang = fence[2] || '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        const raw = lines[i];
        codeLines.push(indent && raw.startsWith(indent) ? raw.slice(indent.length) : raw);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') });
      continue;
    }

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line) && !/^\s*[-*]\s+\S/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3 | 4,
        text: heading[2].trim(),
      });
      i++;
      continue;
    }

    if (isTableStart(lines, i)) {
      const headers = splitTableRow(lines[i]);
      const alignments = parseTableAlignments(lines[i + 1], headers.length);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const row = splitTableRow(lines[i]);
        while (row.length < headers.length) row.push('');
        rows.push(row.slice(0, headers.length));
        i++;
      }
      blocks.push({ type: 'table', headers, alignments, rows });
      continue;
    }

    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', lines: quoteLines });
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    const ol = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const items: ListItem[] = [];
      while (i < lines.length) {
        const match = ordered ? lines[i].match(/^\s*\d+\.\s+(.+)$/) : lines[i].match(/^\s*[-*]\s+(.+)$/);
        if (!match) break;
        const body = match[1];
        const taskMatch = !ordered ? body.match(/^\[( |x|X)\]\s+(.+)$/) : null;
        if (taskMatch) {
          items.push({ text: taskMatch[2], checked: taskMatch[1].toLowerCase() === 'x' });
        } else {
          items.push({ text: body });
        }
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length
      && lines[i].trim()
      && !/^\s*```/.test(lines[i])
      && !/^#{1,4}\s+/.test(lines[i])
      && !lines[i].startsWith('>')
      && !/^\s*(?:[-*]|\d+\.)\s+/.test(lines[i])
      && !(/^\s*(?:[-*_]\s*){3,}$/.test(lines[i]) && !/^\s*[-*]\s+\S/.test(lines[i]))
      && !isTableStart(lines, i)
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      blocks.push({ type: 'paragraph', text: paraLines.join('\n') });
    }
  }
  return blocks;
}

function safeHref(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function safeImageSrc(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('/api/') || trimmed.startsWith('/motion-api/')) {
    return trimmed;
  }
  return safeHref(trimmed);
}

function formatFileChipLabel(fileRef: string): { fullPath: string; display: string } {
  const clean = fileRef.replace(/^file:\/\//i, '');
  const parts = clean.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return { fullPath: clean, display: clean || fileRef };
  return { fullPath: clean, display: parts.slice(-2).join('/') };
}

type InlineRenderOptions = {
  onCopyCode?: (code: string) => void;
  onOpenWebUrl?: (url: string) => void;
  openViewerLabel: string;
  copyPathLabel: string;
};

function renderLink(
  key: number,
  label: string,
  href: string,
  opts: InlineRenderOptions,
): ReactNode {
  return (
    <span key={key} className="om-sa-link-group">
      <a href={href} target="_blank" rel="noopener noreferrer" className="om-sa-link">
        {label}
      </a>
      {opts.onOpenWebUrl && (
        <IconButton
          variant="plain"
          className="om-sa-link-viewer-btn"
          aria-label={opts.openViewerLabel}
          title={opts.openViewerLabel}
          onClick={() => opts.onOpenWebUrl?.(href)}
          icon={<RemixIcon name="arrow-right-up-line" size={12} />}
        />
      )}
    </span>
  );
}

function renderFileChip(
  key: number,
  rawTarget: string,
  label: string | undefined,
  opts: InlineRenderOptions,
): ReactNode {
  const { fullPath, display } = formatFileChipLabel(rawTarget);
  return (
    <Button
      key={key}
      variant="plain"
      type="button"
      className="om-sa-file-chip"
      title={`${opts.copyPathLabel}: ${fullPath}`}
      onClick={() => opts.onCopyCode?.(fullPath)}
    >
      <RemixIcon name="file-text-line" size={12} />
      <span>{label || display}</span>
    </Button>
  );
}

function renderInline(text: string, opts: InlineRenderOptions): ReactNode[] {
  const tokens: ReactNode[] = [];
  const pattern = /(!\[[^\]]*\]\([^\s)]+\)|`[^`\n]+`|\[[^\]]+\]\((?:https?:\/\/|file:\/\/)[^\s)]+\)|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*|https?:\/\/[^\s<>()]+|file:\/\/\/[^\s<>()]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) tokens.push(text.slice(last, match.index));
    const full = match[0];

    if (full.startsWith('![')) {
      const altEnd = full.indexOf('](');
      const alt = full.slice(2, altEnd);
      const rawUrl = full.slice(altEnd + 2, -1);
      const src = safeImageSrc(rawUrl);
      if (src) {
        tokens.push(
          <span key={key++} className="om-sa-md-image-wrap">
            <img src={src} alt={alt} loading="lazy" className="om-sa-md-image" />
          </span>,
        );
      } else {
        tokens.push(full);
      }
    } else if (full.startsWith('`')) {
      const inner = full.slice(1, -1);
      if (inner.startsWith('file://') && opts.onCopyCode) {
        tokens.push(renderFileChip(key++, inner, undefined, opts));
      } else {
        tokens.push(<code key={key++} className="om-sa-inline-code">{inner}</code>);
      }
    } else if (full.startsWith('**')) {
      tokens.push(<strong key={key++}>{full.slice(2, -2)}</strong>);
    } else if (full.startsWith('~~')) {
      tokens.push(<del key={key++} className="om-sa-md-del">{full.slice(2, -2)}</del>);
    } else if (full.startsWith('*')) {
      tokens.push(<em key={key++}>{full.slice(1, -1)}</em>);
    } else if (full.startsWith('[')) {
      const labelEnd = full.indexOf('](');
      const label = full.slice(1, labelEnd);
      const rawTarget = full.slice(labelEnd + 2, -1);
      if (rawTarget.startsWith('file://')) {
        tokens.push(renderFileChip(key++, rawTarget, label, opts));
      } else {
        const href = safeHref(rawTarget);
        if (href) {
          tokens.push(renderLink(key++, label, href, opts));
        } else {
          tokens.push(full);
        }
      }
    } else if (full.startsWith('file://')) {
      const trimmed = full.replace(/[.,;:!?)]+$/, '');
      const suffix = full.slice(trimmed.length);
      tokens.push(renderFileChip(key++, trimmed, undefined, opts));
      if (suffix) tokens.push(suffix);
    } else if (full.startsWith('http://') || full.startsWith('https://')) {
      const trimmed = full.replace(/[.,;:!?)]+$/, '');
      const suffix = full.slice(trimmed.length);
      const href = safeHref(trimmed);
      if (href) {
        tokens.push(renderLink(key++, trimmed, href, opts));
      } else {
        tokens.push(trimmed);
      }
      if (suffix) tokens.push(suffix);
    }
    last = match.index + full.length;
  }
  if (last < text.length) tokens.push(text.slice(last));
  return tokens;
}

export function SimpleMarkdown({
  content,
  onCopyCode,
  onOpenWebUrl,
}: {
  content: string;
  onCopyCode?: (code: string) => void;
  onOpenWebUrl?: (url: string) => void;
}) {
  const { t } = useI18n();
  const blocks = useMemo(() => parseBlocks(content), [content]);
  const inlineOpts: InlineRenderOptions = {
    onCopyCode,
    onOpenWebUrl,
    openViewerLabel: t('Open in Viewer'),
    copyPathLabel: t('Copy path'),
  };

  return (
    <div className="om-sa-markdown">
      {blocks.map((block, index) => {
        if (block.type === 'code') {
          return (
            <div key={index} className="om-sa-code-card">
              <div className="om-sa-code-head">
                <span>{block.lang || 'text'}</span>
                {onCopyCode && (
                  <IconButton
                    variant="ghost"
                    className="motion-icon-button"
                    aria-label={t('Copy code')}
                    onClick={() => onCopyCode(block.code)}
                    icon={<RemixIcon name="file-copy-line" size={14} />}
                  />
                )}
              </div>
              <pre className="om-sa-code-pre">
                <code>{block.code}</code>
              </pre>
            </div>
          );
        }
        if (block.type === 'hr') {
          return <hr key={index} className="om-sa-md-hr" />;
        }
        if (block.type === 'heading') {
          const Tag = block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : block.level === 3 ? 'h5' : 'h6';
          return (
            <Tag key={index} className="om-sa-md-heading" data-level={block.level}>
              {renderInline(block.text, inlineOpts)}
            </Tag>
          );
        }
        if (block.type === 'table') {
          return (
            <div key={index} className="om-sa-md-table-wrap">
              <table className="om-sa-md-table">
                <thead>
                  <tr>
                    {block.headers.map((header, ci) => (
                      <th key={ci} data-align={block.alignments[ci]}>
                        {renderInline(header, inlineOpts)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci} data-align={block.alignments[ci]}>
                          {renderInline(cell, inlineOpts)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.type === 'quote') {
          return (
            <blockquote key={index} className="om-sa-md-quote">
              {block.lines.map((line, i) => (
                <Fragment key={i}>
                  {i > 0 && <br />}
                  {renderInline(line, inlineOpts)}
                </Fragment>
              ))}
            </blockquote>
          );
        }
        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag key={index} className="om-sa-md-list">
              {block.items.map((item, i) => (
                <li key={i} className={item.checked !== undefined ? 'om-sa-md-task' : undefined}>
                  {item.checked !== undefined && (
                    <span className="om-sa-md-task-box" data-checked={item.checked || undefined} aria-hidden="true">
                      <RemixIcon name={item.checked ? 'checkbox-circle-line' : 'checkbox-blank-line'} size={14} />
                    </span>
                  )}
                  <span>{renderInline(item.text, inlineOpts)}</span>
                </li>
              ))}
            </ListTag>
          );
        }
        return (
          <p key={index} className="om-sa-md-para">
            {block.text.split('\n').map((line, i) => (
              <Fragment key={i}>
                {i > 0 && <br />}
                {renderInline(line, inlineOpts)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
