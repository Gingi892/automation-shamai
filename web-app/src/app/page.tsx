'use client';

import { useCallback, useState } from 'react';
import { SearchBar } from '@/components/search/search-bar';
import { SearchResults } from '@/components/search/search-results';
import { SearchFiltersPanel } from '@/components/search/search-filters';
import { SortControls } from '@/components/search/sort-controls';
import { ComparisonTable } from '@/components/search/comparison-table';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useSearch } from '@/hooks/use-search';
import { Scale, SlidersHorizontal } from 'lucide-react';
import type { SearchFilters } from '@/types/api';

export default function HomePage() {
  const {
    results,
    loading,
    error,
    search,
    loadMore,
    query,
    filters,
    sort,
    setFilters,
    setSort,
  } = useSearch();

  const handleSearch = useCallback(
    (q: string) => {
      search(q, filters, sort);
    },
    [search, filters, sort]
  );

  const handleFilterChange = useCallback(
    (newFilters: SearchFilters) => {
      setFilters(newFilters);
      if (query) search(query, newFilters, sort);
    },
    [query, search, sort, setFilters]
  );

  const handleSortChange = useCallback(
    (newSort: 'relevance' | 'date') => {
      setSort(newSort);
      if (query) search(query, filters, newSort);
    },
    [query, search, filters, setSort]
  );

  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const hasResults = results && results.results.length > 0;
  const showEmptyState = !results && !loading && !error;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center gap-3 mb-4">
            <Scale className="h-6 w-6 text-primary" />
            <div>
              <h1 className="text-lg font-bold">מנוע חיפוש שמאות מקרקעין</h1>
              <p className="text-xs text-muted-foreground">
                31,000+ החלטות שמאי מכריע, ועדת השגות וועדת ערעורים
              </p>
            </div>
          </div>
          <div className="max-w-3xl">
            <SearchBar
              onSearch={handleSearch}
              loading={loading}
              initialQuery={query}
            />
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        {showEmptyState && <EmptyState onSearch={handleSearch} />}

        {(hasResults || loading || error) && (
          <div className="flex gap-6">
            {/* Filters sidebar */}
            <aside className="w-64 flex-shrink-0 hidden lg:block">
              <div className="sticky top-28">
                <SearchFiltersPanel
                  aggregations={results?.aggregations ?? null}
                  filters={filters}
                  onFilterChange={handleFilterChange}
                />
              </div>
            </aside>

            {/* Results area */}
            <div className="flex-1 min-w-0">
              {/* Sort controls + mobile filter button */}
              {hasResults && (
                <div className="flex items-center justify-between mb-4">
                  <SortControls sort={sort} onSortChange={handleSortChange} />
                  <Button
                    variant="outline"
                    size="sm"
                    className="lg:hidden gap-1.5"
                    onClick={() => setFilterSheetOpen(true)}
                  >
                    <SlidersHorizontal className="h-4 w-4" />
                    סינון
                    {activeFilterCount > 0 && (
                      <Badge variant="default" className="text-[10px] h-4 min-w-4 px-1">
                        {activeFilterCount}
                      </Badge>
                    )}
                  </Button>
                </div>
              )}

              {/* Comparison table for parameter searches */}
              {hasResults && query && (
                <ComparisonTable
                  query={query}
                  committee={results?.autoFilters?.committee}
                />
              )}

              {/* Search results */}
              <SearchResults
                response={results}
                loading={loading}
                error={error}
                onLoadMore={loadMore}
                query={query}
              />
            </div>
          </div>
        )}

        {/* Mobile filter sheet */}
        <Sheet open={filterSheetOpen} onOpenChange={setFilterSheetOpen}>
          <SheetContent side="right" className="w-[300px] overflow-y-auto">
            <SheetHeader>
              <SheetTitle>סינון תוצאות</SheetTitle>
            </SheetHeader>
            <div className="px-4 pb-4">
              <SearchFiltersPanel
                aggregations={results?.aggregations ?? null}
                filters={filters}
                onFilterChange={(newFilters) => {
                  handleFilterChange(newFilters);
                  setFilterSheetOpen(false);
                }}
              />
            </div>
          </SheetContent>
        </Sheet>
      </main>
    </div>
  );
}

function EmptyState({ onSearch }: { onSearch: (q: string) => void }) {
  const examples = [
    'מקדם דחייה תל אביב',
    'שווי קרקע חיפה 2024',
    'עסקאות השוואה רמת גן',
    'היטל השבחה ירושלים',
  ];

  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <Scale className="h-12 w-12 text-muted-foreground/40 mb-6" />
      <h2 className="text-xl font-semibold mb-2">מנוע חיפוש החלטות שמאות מקרקעין</h2>
      <p className="text-sm text-muted-foreground mb-3 max-w-lg">
        חפש בין 31,000+ החלטות שמאי מכריע, ועדת השגות וועדת ערעורים.
        המערכת מציגה נתונים מדויקים, ציטוטים מקוריים וסכומים מתוך המסמכים.
      </p>

      {/* Database counts */}
      <div className="flex gap-4 text-xs text-muted-foreground mb-8">
        <span>שמאי מכריע: ~24,000</span>
        <span className="text-border">|</span>
        <span>ועדת השגות: ~6,000</span>
        <span className="text-border">|</span>
        <span>ועדת ערעורים: ~1,000</span>
      </div>

      {/* Search tips */}
      <div className="mb-8 text-sm text-muted-foreground max-w-md text-right">
        <h3 className="font-semibold text-foreground mb-2 text-center">טיפים לחיפוש</h3>
        <ul className="space-y-1 list-disc list-inside">
          <li>חפש פרמטרים מקצועיים: &quot;מקדם דחייה&quot;, &quot;מקדם גודל&quot;, &quot;שווי למ&quot;ר&quot;</li>
          <li>הוסף מיקום ושנה לתוצאות ממוקדות: &quot;שווי קרקע חיפה 2024&quot;</li>
          <li>חפש עסקאות השוואה לנתוני שוק גולמיים</li>
          <li>כל ערך מקושר ישירות ל-PDF המקור עם מספר עמוד</li>
        </ul>
      </div>

      {/* Example searches */}
      <div className="grid grid-cols-2 gap-3 text-sm max-w-lg w-full">
        {examples.map((q) => (
          <button
            key={q}
            onClick={() => onSearch(q)}
            className="text-right p-3 rounded-lg border hover:bg-accent transition-colors cursor-pointer"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
