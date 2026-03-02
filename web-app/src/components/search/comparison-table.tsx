'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Table2,
  ChevronDown,
  ChevronUp,
  ArrowUpDown,
  ExternalLink,
  Loader2,
  X,
  Pencil,
  RefreshCw,
} from 'lucide-react';

// ──────────────────────────────────────────────────────────────────
// Only show for parameter-like queries
// ──────────────────────────────────────────────────────────────────

const PARAMETER_KEYWORDS = [
  'מקדם', 'שווי', 'מחיר', 'ערך',
  'עסקאות השוואה', 'נתוני השוואה',
  'תחשיב', 'היטל', 'פיצוי',
  'למ"ר', 'לדונם', 'למטר',
  'דמי סחירות', 'ריבון',
  'זכויות בנייה', 'זכויות בניה',
];

// ──────────────────────────────────────────────────────────────────
// Types matching API response
// ──────────────────────────────────────────────────────────────────

interface ColumnDef {
  key: string;
  label: string;
  prompt: string;
}

interface ClaimValue {
  display: string | null;
  numeric: number | null;
  unit: string | null;
  quote: string | null;
}

interface CompareRow {
  id: string;
  title: string;
  database: string;
  committee: string | null;
  year: string | null;
  appraiser: string | null;
  url: string | null;
  values: Record<string, ClaimValue>;
}

interface CompareStats {
  count: number;
  avg: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

interface CompareResponse {
  rows: CompareRow[];
  total: number;
  committee: string | null;
  stats: CompareStats;
  columns: ColumnDef[];
  paramType: string | null;
  valueLabel: string;
  source: 'parameters' | 'ai';
}

interface ComparisonTableProps {
  query: string;
  committee?: string;
  resultIds?: string[];
}

type SortField = 'year' | 'committee' | 'appraiser' | string; // string for dynamic column keys

// ──────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────

export function ComparisonTable({ query, committee, resultIds }: ComparisonTableProps) {
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [sortField, setSortField] = useState<SortField>('year');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const lastFetchedQuery = useRef<string>('');

  // Editable columns — null means "use whatever the API returns"
  const [editingColumns, setEditingColumns] = useState(false);
  const [customColumns, setCustomColumns] = useState<ColumnDef[] | null>(null);

  useEffect(() => {
    if (query !== lastFetchedQuery.current) {
      setLoaded(false);
      setData(null);
      setExpandedRows(new Set());
      setCustomColumns(null);
      setEditingColumns(false);
    }
  }, [query]);

  const isParameterQuery = PARAMETER_KEYWORDS.some((kw) => query.includes(kw));
  if (!isParameterQuery) return null;

  const fetchData = async (columnsOverride?: ColumnDef[]) => {
    setLoading(true);
    lastFetchedQuery.current = query;
    try {
      const payload: Record<string, unknown> = { query, committee, limit: 50, resultIds };
      if (columnsOverride) payload.columns = columnsOverride;
      const res = await fetch('/api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) { setData(null); return; }
      const json = await res.json();
      setData(json);
      // If API returned columns and we don't have custom ones, seed editable state
      if (!columnsOverride && json.columns) {
        setCustomColumns(json.columns);
      }
    } catch {
      setData(null);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  };

  const handleExpand = async () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (loaded && query === lastFetchedQuery.current) return;
    await fetchData();
  };

  const handleReExtract = async () => {
    if (!customColumns || customColumns.length === 0) return;
    setEditingColumns(false);
    await fetchData(customColumns);
  };

  const rows = data?.rows ?? [];
  const columns = data?.columns ?? [];
  const isParamsSource = data?.source === 'parameters';

  const sortedRows = [...rows].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortField === 'year') return ((a.year || '') > (b.year || '') ? 1 : -1) * dir;
    if (sortField === 'committee') return ((a.committee || '') > (b.committee || '') ? 1 : -1) * dir;
    if (sortField === 'appraiser') return ((a.appraiser || '') > (b.appraiser || '') ? 1 : -1) * dir;
    // Sort by dynamic column numeric value
    const aVal = a.values[sortField]?.numeric ?? 0;
    const bVal = b.values[sortField]?.numeric ?? 0;
    return (aVal - bVal) * dir;
  });

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('desc'); }
  };

  const toggleRowExpand = (id: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const updateColumn = (idx: number, field: 'label' | 'prompt', value: string) => {
    setCustomColumns(prev => {
      if (!prev) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  };

  const badgeText = data?.committee
    ? `${rows.length} החלטות מוועדת ${data.committee}`
    : `${rows.length} החלטות`;

  const sourceBadge = isParamsSource ? 'אינדקס פרמטרים' : 'חילוץ AI';

  // Column colors — cycle through a set
  const COL_COLORS = [
    { text: 'text-blue-700', border: 'border-blue-300' },
    { text: 'text-orange-700', border: 'border-orange-300' },
    { text: 'text-green-700', border: 'border-green-300' },
    { text: 'text-purple-700', border: 'border-purple-300' },
    { text: 'text-rose-700', border: 'border-rose-300' },
  ];

  return (
    <TooltipProvider>
      <div className="mb-4 border rounded-lg">
        {/* Header */}
        <button
          onClick={handleExpand}
          className="w-full flex items-center gap-2 p-3 text-sm font-semibold hover:bg-muted/50 transition-colors cursor-pointer"
        >
          <Table2 className="h-4 w-4 text-primary" />
          <span>טבלת השוואה מצרפית</span>
          {loaded && data && (
            <>
              <Badge variant="secondary" className="text-[10px]">{badgeText}</Badge>
              <Badge variant="outline" className="text-[10px]">{sourceBadge}</Badge>
              {columns.length > 0 && (
                <Badge variant="outline" className="text-[10px] text-green-700 border-green-300">
                  {columns.map(c => c.label).join(' / ')}
                </Badge>
              )}
            </>
          )}
          <div className="flex-1" />
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>

        {expanded && (
          <div className="border-t">
            {/* Query bar + edit columns + close */}
            <div className="flex items-center justify-between px-3 py-2 bg-muted/20 border-b">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">חיפוש:</span>
                <span className="font-semibold">{query}</span>
              </div>
              <div className="flex items-center gap-1">
                {!isParamsSource && loaded && data && (
                  <button
                    onClick={() => setEditingColumns(!editingColumns)}
                    className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-muted transition-colors cursor-pointer"
                    title="ערוך עמודות חילוץ"
                  >
                    <Pencil className="h-3 w-3" />
                    ערוך עמודות
                  </button>
                )}
                <button
                  onClick={() => setExpanded(false)}
                  className="p-1 rounded hover:bg-muted transition-colors cursor-pointer"
                  title="סגור טבלה"
                >
                  <X className="h-4 w-4 text-muted-foreground" />
                </button>
              </div>
            </div>

            {/* Column editor */}
            {editingColumns && customColumns && (
              <div className="px-3 py-3 border-b bg-muted/10 space-y-3">
                <div className="text-xs text-muted-foreground mb-2">
                  ערוך את העמודות שה-AI מחלץ מהמסמכים. שנה את הכותרת או את ההנחיה לחילוץ.
                </div>
                {customColumns.map((col, idx) => {
                  const color = COL_COLORS[idx % COL_COLORS.length];
                  return (
                    <div key={col.key} className="flex gap-2 items-start">
                      <div className={`flex-shrink-0 w-2 h-full rounded ${color.border} border-r-2 mt-1`} />
                      <div className="flex-1 space-y-1">
                        <input
                          type="text"
                          value={col.label}
                          onChange={(e) => updateColumn(idx, 'label', e.target.value)}
                          className="w-full text-sm font-semibold bg-background border rounded px-2 py-1"
                          placeholder="כותרת עמודה"
                          dir="rtl"
                        />
                        <input
                          type="text"
                          value={col.prompt}
                          onChange={(e) => updateColumn(idx, 'prompt', e.target.value)}
                          className="w-full text-xs text-muted-foreground bg-background border rounded px-2 py-1"
                          placeholder="הנחיה ל-AI — מה לחלץ?"
                          dir="rtl"
                        />
                      </div>
                    </div>
                  );
                })}
                <button
                  onClick={handleReExtract}
                  disabled={loading}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                  חלץ מחדש
                </button>
              </div>
            )}

            <div className="p-3">
              {loading && (
                <div className="flex items-center justify-center py-6 gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  מחלץ נתונים מהחלטות — עד 20 שניות...
                </div>
              )}

              {!loading && rows.length === 0 && loaded && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  לא נמצאו נתונים מתאימים
                </p>
              )}

              {!loading && rows.length > 0 && data && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-xs text-muted-foreground">
                        <th className="text-right py-2 px-2 font-medium w-6"></th>
                        <th className="text-right py-2 px-2 font-medium">החלטה</th>
                        <SortableHeader label="ועדה" field="committee" currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                        <SortableHeader label="שנה" field="year" currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                        <SortableHeader label="שמאי" field="appraiser" currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                        {columns.map((col, idx) => {
                          const color = COL_COLORS[idx % COL_COLORS.length];
                          const isLast = idx === columns.length - 1;
                          return (
                            <SortableHeader
                              key={col.key}
                              label={col.label}
                              field={col.key}
                              currentField={sortField}
                              currentDir={sortDir}
                              onSort={handleSort}
                              className={isLast ? 'text-green-700 font-semibold' : color.text}
                            />
                          );
                        })}
                        <th className="text-right py-2 px-2 font-medium w-8"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRows.map((row) => (
                        <RowComponent
                          key={row.id}
                          row={row}
                          columns={columns}
                          colColors={COL_COLORS}
                          isExpanded={expandedRows.has(row.id)}
                          onToggle={() => toggleRowExpand(row.id)}
                        />
                      ))}
                    </tbody>
                    {data.stats && data.stats.avg !== null && (
                      <tfoot>
                        <tr className="border-t-2 bg-muted/30 text-xs font-semibold">
                          <td className="py-2 px-2"></td>
                          <td className="py-2 px-2 text-muted-foreground">סיכום ({data.stats.count})</td>
                          <td className="py-2 px-2"></td>
                          <td className="py-2 px-2"></td>
                          <td className="py-2 px-2"></td>
                          {columns.map((col, idx) => {
                            const isLast = idx === columns.length - 1;
                            return (
                              <td key={col.key} className="py-2 px-2">
                                {isLast && (
                                  <div className="space-y-0.5 text-green-700">
                                    <div>ממוצע: {fmt(data.stats.avg)}</div>
                                    <div>חציון: {fmt(data.stats.median)}</div>
                                    <div>טווח: {fmt(data.stats.min)} – {fmt(data.stats.max)}</div>
                                  </div>
                                )}
                              </td>
                            );
                          })}
                          <td className="py-2 px-2"></td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

// ──────────────────────────────────────────────────────────────────
// Row component — dynamic columns
// ──────────────────────────────────────────────────────────────────

function RowComponent({
  row,
  columns,
  colColors,
  isExpanded,
  onToggle,
}: {
  row: CompareRow;
  columns: ColumnDef[];
  colColors: { text: string; border: string }[];
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const hasQuotes = columns.some(col => row.values[col.key]?.quote);
  const colSpan = 6 + columns.length;

  return (
    <>
      <tr className="border-b last:border-0 hover:bg-muted/30">
        <td className="py-2 px-1">
          {hasQuotes && (
            <button onClick={onToggle} className="p-0.5 rounded hover:bg-muted transition-colors cursor-pointer" title="הצג ציטוטים">
              {isExpanded ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
            </button>
          )}
        </td>
        <td className="py-2 px-2 max-w-[220px] truncate" title={row.title}>
          <Link href={`/decision/${row.id}`} className="hover:text-primary hover:underline transition-colors">
            {row.title}
          </Link>
        </td>
        <td className="py-2 px-2 text-xs">{row.committee || '-'}</td>
        <td className="py-2 px-2 text-xs">{row.year || '-'}</td>
        <td className="py-2 px-2 text-xs max-w-[120px] truncate" title={row.appraiser || undefined}>
          {row.appraiser || '-'}
        </td>
        {columns.map((col, idx) => {
          const color = colColors[idx % colColors.length];
          const isLast = idx === columns.length - 1;
          return (
            <td key={col.key} className={`py-2 px-2 text-xs ${isLast ? 'font-semibold text-green-700' : color.text}`}>
              <ClaimCell claim={row.values[col.key]} />
            </td>
          );
        })}
        <td className="py-2 px-2">
          {row.url && (
            <a href={row.url} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground">
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </td>
      </tr>
      {isExpanded && hasQuotes && (
        <tr className="bg-muted/20">
          <td colSpan={colSpan} className="py-2 px-4">
            <div className="text-xs space-y-1.5">
              {columns.map((col, idx) => {
                const quote = row.values[col.key]?.quote;
                if (!quote) return null;
                const color = colColors[idx % colColors.length];
                const isLast = idx === columns.length - 1;
                return (
                  <div key={col.key}>
                    <span className={`font-semibold ${isLast ? 'text-green-700' : color.text}`}>{col.label}: </span>
                    <span className="text-muted-foreground">&quot;{quote}&quot;</span>
                  </div>
                );
              })}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ──────────────────────────────────────────────────────────────────
// Claim cell — value with tooltip quote
// ──────────────────────────────────────────────────────────────────

function ClaimCell({ claim }: { claim: ClaimValue | null | undefined }) {
  if (!claim?.display) return <span>-</span>;

  if (claim.quote) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help border-b border-dotted border-current">
            {claim.display}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[400px] text-right" dir="rtl">
          <p className="text-xs leading-relaxed">&quot;{claim.quote}&quot;</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return <span>{claim.display}</span>;
}

// ──────────────────────────────────────────────────────────────────
// Sortable header
// ──────────────────────────────────────────────────────────────────

function SortableHeader({
  label, field, currentField, currentDir, onSort, className = '',
}: {
  label: string;
  field: SortField;
  currentField: SortField;
  currentDir: 'asc' | 'desc';
  onSort: (field: SortField) => void;
  className?: string;
}) {
  const isActive = currentField === field;
  return (
    <th className={`text-right py-2 px-2 font-medium ${className}`}>
      <button onClick={() => onSort(field)} className="flex items-center gap-0.5 hover:text-foreground cursor-pointer">
        {label}
        <ArrowUpDown className={`h-3 w-3 ${isActive ? 'opacity-100' : 'opacity-30'}`} />
        {isActive && <span className="text-[9px]">{currentDir === 'asc' ? '↑' : '↓'}</span>}
      </button>
    </th>
  );
}

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-';
  return v.toLocaleString('he-IL');
}
