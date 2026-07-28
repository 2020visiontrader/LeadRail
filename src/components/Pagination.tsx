import Button from '@/components/Button';
export default function Pagination({ page, total, limit, onPage }: { page: number; total: number; limit: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="flex items-center justify-between pt-4 text-sm text-slate-600">
      <span>{total} total</span>
      <div className="flex items-center gap-3">
        <Button variant="secondary" disabled={page <= 0} onClick={() => onPage(page - 1)}>Prev</Button>
        <span>Page {page + 1} of {pages}</span>
        <Button variant="secondary" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  );
}
