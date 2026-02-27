'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Table2,
  ChevronDown,
  ChevronUp,
  ArrowUpDown,
  ExternalLink,
  Loader2,
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

interface ComparisonRow {
  id: string;
  title: string;
  database: string;
  committee: string | null;
  year: string | null;
  url: string | null;
  partyAValue: string | null;
  partyBValue: string | null;
  rulingValue: string | null;
  rulingNumeric: number | null;
}

interface ComparisonTableProps {
  query: string;
  committee?: string;
}

type SortField = 'year' | 'ruling' | 'committee';

export function ComparisonTable({ query, committee }: ComparisonTableProps) {
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<ComparisonRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [sortField, setSortField] = useState<SortField>('year');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [filteredCommittee, setFilteredCommittee] = useState<string | null>(null);

  // Only show for parameter-like queries
  const isParameterQuery = PARAMETER_KEYWORDS.some((kw) => query.includes(kw));
  if (!isParameterQuery) return null;

  const handleExpand = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }

    setExpanded(true);

    if (loaded) return;

    setLoading(true);

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
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [expanded, loaded, query, committee]);

  // Sort rows
  const sortedRows = [...rows].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortField === 'year') {
      return ((a.year || '') > (b.year || '') ? 1 : -1) * dir;
    }
    if (sortField === 'ruling') {
      return ((a.rulingNumeric || 0) - (b.rulingNumeric || 0)) * dir;
    }
    if (sortField === 'committee') {
      return ((a.committee || '') > (b.committee || '') ? 1 : -1) * dir;
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

  const badgeText = filteredCommittee
    ? `${rows.length} החלטות מוועדת ${filteredCommittee}`
    : `${rows.length} החלטות`;

  return (
    <div className="mb-4 border rounded-lg">
      <button
        onClick={handleExpand}
        className="w-full flex items-center gap-2 p-3 text-sm font-semibold hover:bg-muted/50 transition-colors cursor-pointer"
      >
        <Table2 className="h-4 w-4 text-primary" />
        <span>טבלת השוואה מצרפית</span>
        {loaded && (
          <Badge variant="secondary" className="text-[10px]">
            {badgeText}
          </Badge>
        )}
        <div className="flex-1" />
        {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>

      {expanded && (
        <div className="border-t p-3">
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
                    <tr key={row.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-2 px-2 max-w-[200px] truncate" title={row.title}>
                        <Link href={`/decision/${row.id}`} className="hover:text-primary hover:underline transition-colors">
                          {row.title}
                        </Link>
                      </td>
                      <td className="py-2 px-2 text-xs">
                        {DATABASE_LABELS[row.database] || row.database}
                      </td>
                      <td className="py-2 px-2 text-xs">{row.committee || '-'}</td>
                      <td className="py-2 px-2 text-xs">{row.year || '-'}</td>
                      <td className="py-2 px-2 text-xs text-blue-700">{row.partyAValue || '-'}</td>
                      <td className="py-2 px-2 text-xs text-orange-700">{row.partyBValue || '-'}</td>
                      <td className="py-2 px-2 text-xs font-semibold text-green-700">
                        {row.rulingValue || '-'}
                      </td>
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
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
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
