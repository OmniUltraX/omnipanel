import { useEffect, useState } from "react";

export const CLOUD_PAGE_SIZES = [20, 50, 100] as const;
export const CLOUD_DEFAULT_PAGE_SIZE = 20;
/** 阿里云慢日志 DescribeSlowLogRecords 只接受 30 / 50 / 100。 */
export const CLOUD_LOG_PAGE_SIZES = [30, 50, 100] as const;
export const CLOUD_LOG_DEFAULT_PAGE_SIZE = 30;

export type CloudPaging<T> = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  slice: T[];
  from: number;
  to: number;
};

export function paginateCloudItems<T>(
  items: T[],
  page: number,
  pageSize: number,
): CloudPaging<T> {
  const size = pageSize > 0 ? pageSize : CLOUD_DEFAULT_PAGE_SIZE;
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / size) || 1);
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * size;
  const slice = items.slice(start, start + size);
  return {
    page: safePage,
    pageSize: size,
    total,
    totalPages,
    slice,
    from: total === 0 ? 0 : start + 1,
    to: start + slice.length,
  };
}

export function useCloudPaging<T>(items: T[], resetKey: string, pageSize = CLOUD_DEFAULT_PAGE_SIZE) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(pageSize);

  useEffect(() => {
    setPage(1);
  }, [resetKey, size]);

  const paging = paginateCloudItems(items, page, size);

  useEffect(() => {
    if (paging.page !== page) setPage(paging.page);
  }, [page, paging.page]);

  return {
    ...paging,
    setPage,
    setPageSize: setSize,
  };
}
