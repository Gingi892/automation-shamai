'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
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
  FileText,
  X,
} from 'lucide-react';
import { DATABASE_LABELS } from '@/lib/constants';

/** Only show comparison table for queries that look like parameter searches */
const PARAMETER_KEYWORDS = [
  'מקדם',
  'שווי',
  'מחיר',
  'ערך',
  'עסקאות השוואה',
  'נתוני השוואה',
  'תחשיב',
  'היטל',
  'פיצוי',
  'למ"ר',
  'לדונם',
  'למטר',
];

interface ValueWithContext {
  display: string | null;
  numeric: number | null;
  context: string | null;
  page: number | null;
}

interface ComparisonRow {
  id: string;
  title: string;
  database: string;
  committee: string | null;
  year: string | null;
  appraiser: string | null;
  url: string | null;
  partyA: ValueWithContext;
  partyB: ValueWithContext;
  ruling: ValueWithContext;
}

interface CompareStats {
  count: number;
  avg: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

interface QueryTypeInfo {
  paramType: string | null;
  subtypePrefix: string | null;
  columnType: 'coefficient' | 'price' | 'transaction' | 'general';
}

interface ComparisonTableProps {
  query: string;
  committee?: string;
}

type SortField = 'year' | 'ruling' | 'committee' | 'appraiser';

export function ComparisonTable({ query, committee }: ComparisonTableProps) {
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<ComparisonRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [sortField, setSortField] = useState<SortField>('year');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [filteredCommittee, setFilteredCommittee] = useState<string | null>(null);
  const [stats, setStats] = useState<CompareStats | null>(null);
  const [queryType, setQueryType] = useState<QueryTypeInfo | null>(null);
  const [source, setSource] = useState<'parameters' | 'extraction'>('extraction');
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const lastFetchedQuery = useRef<string>('');

  // Reset state when query changes so new search triggers fresh fetch
  useEffect(() => {
    if (query !== lastFetchedQuery.current) {
      setLoaded(false);
      setRows([]);
      setStats(null);
      setExpandedRows(new Set());
    }
  }, [query]);

  // Only show for parameter-like queries
  const isParameterQuery = PARAMETER_KEYWORDS.some((kw) => query.includes(kw));
  if (!isParameterQuery) return null;

  const fetchData = async () => {
    setLoading(true);
    lastFetchedQuery.current = query;
    try {
      const res = await fetch('/api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, committee, limit: 50 }),
      });

      if (!res.ok) {
        setRows([]);
        return;
      }

      const data = await res.json();
      setRows(data.rows || []);
      setFilteredCommittee(data.committee || null);
      setStats(data.stats || null);
      setQueryType(data.queryType || null);
      setSource(data.source || 'extraction');
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  };

  const handleExpand = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }

    setExpanded(true);

    if (loaded && query === lastFetchedQuery.current) return;

    await fetchData();
  };

  const handleClose = () => {
    setExpanded(false);
  };

  // Sort rows
  const sortedRows = [...rows].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortField === 'year') {
      return ((a.year || '') > (b.year || '') ? 1 : -1) * dir;
    }
    if (sortField === 'ruling') {
      return ((a.ruling?.numeric || 0) - (b.ruling?.numeric || 0)) * dir;
    }
    if (sortField === 'committee') {
      return ((a.committee || '') > (b.committee || '') ? 1 : -1) * dir;
    }
    if (sortField === 'appraiser') {
      return ((a.appraiser || '') > (b.appraiser || '') ? 1 : -1) * dir;
    }
    return 0;
  });

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const toggleRowExpand = (id: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const badgeText = filteredCommittee
    ? `${rows.length} החלטות מוועדת ${filteredCommittee}`
    : `${rows.length} החלטות`;

  const sourceBadge = source === 'parameters' ? 'מאינדקס פרמטרים' : 'חילוץ מטקסט';

  return (
    <TooltipProvider>
      <div className="mb-4 border rounded-lg">
        {/* Header bar */}
        <button
          onClick={handleExpand}
          className="w-full flex items-center gap-2 p-3 text-sm font-semibold hover:bg-muted/50 transition-colors cursor-pointer"
        >
          <Table2 className="h-4 w-4 text-primary" />
          <span>טבלת השוואה מצרפית</span>
          {loaded && (
            <>
              <Badge variant="secondary" className="text-[10px]">
                {badgeText}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {sourceBadge}
              </Badge>
            </>
          )}
          <div className="flex-1" />
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>

        {expanded && (
          <div className="border-t">
            {/* Query bar + close button */}
            <div className="flex items-center justify-between px-3 py-2 bg-muted/20 border-b">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">חיפוש:</span>
                <span className="font-semibold">{query}</span>
              </div>
              <button
                onClick={handleClose}
                className="p-1 rounded hover:bg-muted transition-colors cursor-pointer"
                title="סגור טבלה"
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>

            <div className="p-3">
              {loading && (
                <div className="flex items-center justify-center py-6 gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  מחלץ נתונים מעד 50 החלטות...
                </div>
              )}

              {!loading && rows.length === 0 && loaded && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  לא נמצאו ערכים מספריים בסעיפי הטענות וההכרעה
                </p>
              )}

              {!loading && rows.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-xs text-muted-foreground">
                        <th className="text-right py-2 px-2 font-medium w-6"></th>
                        <th className="text-right py-2 px-2 font-medium">החלטה</th>
                        <th className="text-right py-2 px-2 font-medium">מאגר</th>
                        <SortableHeader
                          label="ועדה"
                          field="committee"
                          currentField={sortField}
                          currentDir={sortDir}
                          onSort={handleSort}
                        />
                        <SortableHeader
                          label="שנה"
                          field="year"
                          currentField={sortField}
                          currentDir={sortDir}
                          onSort={handleSort}
                        />
                        <SortableHeader
                          label="שמאי"
                          field="appraiser"
                          currentField={sortField}
                          currentDir={sortDir}
                          onSort={handleSort}
                        />
                        <th className="text-right py-2 px-2 font-medium text-blue-700">צד א&apos;</th>
                        <th className="text-right py-2 px-2 font-medium text-orange-700">צד ב&apos;</th>
                        <SortableHeader
                          label="הכרעה"
                          field="ruling"
                          currentField={sortField}
                          currentDir={sortDir}
                          onSort={handleSort}
                          className="text-green-700"
                        />
                        <th className="text-right py-2 px-2 font-medium w-8"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRows.map((row) => (
                        <ComparisonRowComponent
                          key={row.id}
                          row={row}
                          isExpanded={expandedRows.has(row.id)}
                          onToggleExpand={() => toggleRowExpand(row.id)}
                        />
                      ))}
                    </tbody>
                    {/* Stats row */}
                    {stats && stats.avg !== null && (
                      <tfoot>
                        <tr className="border-t-2 bg-muted/30 text-xs font-semibold">
                          <td className="py-2 px-2"></td>
                          <td className="py-2 px-2 text-muted-foreground">סיכום</td>
                          <td className="py-2 px-2"></td>
                          <td className="py-2 px-2"></td>
                          <td className="py-2 px-2"></td>
                          <td className="py-2 px-2"></td>
                          <td className="py-2 px-2"></td>
                          <td className="py-2 px-2"></td>
                          <td className="py-2 px-2">
                            <div className="space-y-0.5 text-green-700">
                              <div>ממוצע: {stats.avg?.toLocaleString('he-IL')}</div>
                              <div>חציון: {stats.median?.toLocaleString('he-IL')}</div>
                              <div>טווח: {stats.min?.toLocaleString('he-IL')}-{stats.max?.toLocaleString('he-IL')}</div>
                              <div>n={stats.count}</div>
                            </div>
                          </td>
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

/** A single row in the comparison table, with expandable context */
function ComparisonRowComponent({
  row,
  isExpanded,
  onToggleExpand,
}: {
  row: ComparisonRow;
  isExpanded: boolean;
  onToggleExpand: () => void;
}) {
  const hasContext = row.partyA?.context || row.partyB?.context || row.ruling?.context;
  const colSpan = 10;

  return (
    <>
      <tr className="border-b last:border-0 hover:bg-muted/30">
        {/* Expand button */}
        <td className="py-2 px-1">
          {hasContext && (
            <button
              onClick={onToggleExpand}
              className="p-0.5 rounded hover:bg-muted transition-colors cursor-pointer"
              title="הצג הקשר"
            >
              {isExpanded ? (
                <ChevronUp className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              )}
            </button>
          )}
        </td>
        {/* Title */}
        <td className="py-2 px-2 max-w-[200px] truncate" title={row.title}>
          <Link href={`/decision/${row.id}`} className="hover:text-primary hover:underline transition-colors">
            {row.title}
          </Link>
        </td>
        {/* Database */}
        <td className="py-2 px-2 text-xs">
          {DATABASE_LABELS[row.database] || row.database}
        </td>
        {/* Committee */}
        <td className="py-2 px-2 text-xs">{row.committee || '-'}</td>
        {/* Year */}
        <td className="py-2 px-2 text-xs">{row.year || '-'}</td>
        {/* Appraiser */}
        <td className="py-2 px-2 text-xs max-w-[120px] truncate" title={row.appraiser || undefined}>
          {row.appraiser || '-'}
        </td>
        {/* Party A */}
        <td className="py-2 px-2 text-xs text-blue-700">
          <ValueCell value={row.partyA} url={row.url} />
        </td>
        {/* Party B */}
        <td className="py-2 px-2 text-xs text-orange-700">
          <ValueCell value={row.partyB} url={row.url} />
        </td>
        {/* Ruling */}
        <td className="py-2 px-2 text-xs font-semibold text-green-700">
          <ValueCell value={row.ruling} url={row.url} />
        </td>
        {/* External link */}
        <td className="py-2 px-2">
          {row.url && (
            <a
              href={row.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </td>
      </tr>
      {/* Expanded context row */}
      {isExpanded && hasContext && (
        <tr className="bg-muted/20">
          <td colSpan={colSpan} className="py-2 px-4">
            <div className="text-xs space-y-1.5">
              {row.partyA?.context && (
                <div>
                  <span className="font-semibold text-blue-700">צד א&apos;: </span>
                  <span className="text-muted-foreground">&quot;{row.partyA.context}&quot;</span>
                </div>
              )}
              {row.partyB?.context && (
                <div>
                  <span className="font-semibold text-orange-700">צד ב&apos;: </span>
                  <span className="text-muted-foreground">&quot;{row.partyB.context}&quot;</span>
                </div>
              )}
              {row.ruling?.context && (
                <div>
                  <span className="font-semibold text-green-700">הכרעה: </span>
                  <span className="text-muted-foreground">&quot;{row.ruling.context}&quot;</span>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** Display a value cell with tooltip context and page link */
function ValueCell({ value, url }: { value: ValueWithContext | null | undefined; url: string | null }) {
  if (!value?.display) return <span>-</span>;

  const pageLink = value.page && url
    ? `${url}#page=${value.page}`
    : null;

  if (value.context) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help border-b border-dotted border-current inline-flex items-center gap-1">
            {value.display}
            {pageLink && (
              <a
                href={pageLink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground"
                onClick={(e) => e.stopPropagation()}
              >
                <FileText className="h-2.5 w-2.5" />
              </a>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[350px] text-right" dir="rtl">
          <p className="text-xs leading-relaxed">&quot;{value.context}&quot;</p>
          {value.page && <p className="text-[10px] mt-1 opacity-70">עמ&apos; {value.page}</p>}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      {value.display}
      {pageLink && (
        <a
          href={pageLink}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground"
        >
          <FileText className="h-2.5 w-2.5" />
        </a>
      )}
    </span>
  );
}

function SortableHeader({
  label,
  field,
  currentField,
  currentDir,
  onSort,
  className = '',
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
      <button
        onClick={() => onSort(field)}
        className="flex items-center gap-0.5 hover:text-foreground cursor-pointer"
      >
        {label}
        <ArrowUpDown className={`h-3 w-3 ${isActive ? 'opacity-100' : 'opacity-30'}`} />
        {isActive && (
          <span className="text-[9px]">{currentDir === 'asc' ? '↑' : '↓'}</span>
        )}
      </button>
    </th>
  );
}
